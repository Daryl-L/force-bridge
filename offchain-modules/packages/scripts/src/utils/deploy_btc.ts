import fs from 'fs';
import { CkbDeployManager, OwnerCellConfig } from '@force-bridge/x/dist/ckb/tx-helper/deploy';
import { initLumosConfig } from '@force-bridge/x/dist/ckb/tx-helper/init_lumos_config';
import { CkbDeps, WhiteListEthAsset } from '@force-bridge/x/dist/config';
import { writeJsonToFile } from '@force-bridge/x/dist/utils';
import { logger } from '@force-bridge/x/dist/utils/logger';
import CKB from '@nervosnetwork/ckb-sdk-core';
import * as lodash from 'lodash';
import { genRandomVerifierConfig, VerifierConfig } from './generate';
import { pathFromProjectRoot } from './index';
import { RPCClient } from 'rpc-bitcoin';

export interface BTCDeployDevResult {
  assetWhiteList: WhiteListEthAsset[];
  ckbDeps: CkbDeps;
  multisigConfig: {
    threshold: number;
    verifiers: VerifierConfig[];
  };
  ckbStartHeight: number;
  btcStartHeight: number;
  ckbPrivateKey: string;
}

export async function deployBTCDev(
  clientParams: {
    protocol: string;
    url: string;
    user: string;
    pass: string;
    port: number;
    timeout?: number;
  },
  CKB_RPC_URL: string,
  CKB_INDEXER_URL: string,
  MULTISIG_NUMBER: number,
  MULTISIG_THRESHOLD: number,
  ckbPrivateKey: string,
  env: 'LINA' | 'AGGRON4' | 'DEV' = 'DEV',
  cachePath?: string,
  ckbDeps?: CkbDeps,
): Promise<BTCDeployDevResult> {
  // if (cachePath && fs.existsSync(cachePath)) {
  //   return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  // }
  initLumosConfig(env);
  const verifierConfigs = lodash.range(MULTISIG_NUMBER).map((_i) => genRandomVerifierConfig());
  logger.debug('verifierConfigs', verifierConfigs);
  const ckbDeployGenerator = new CkbDeployManager(CKB_RPC_URL, CKB_INDEXER_URL);
  if (!ckbDeps) {
    // deploy ckb contracts
    let xudtDep;
    let sudtDep;
    let pwLockDep;
    let PATH_BRIDGE_LOCKSCRIPT;
    let PATH_RECIPIENT_TYPESCRIPT;
    if (env === 'DEV') {
      PATH_RECIPIENT_TYPESCRIPT = pathFromProjectRoot('/ckb-contracts/build/release-devnet/recipient-typescript');
      PATH_BRIDGE_LOCKSCRIPT = pathFromProjectRoot('/ckb-contracts/build/release-devnet/bridge-lockscript');
      sudtDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0xe12877ebd2c3c364dc46c5c992bcfaf4fee33fa13eebdf82c591fc9825aab769',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0xc5e5dcf215925f7ef4dfaf5f4b4f105bc321c02776d6e7d52a1db3fcd9d011a4',
          hashType: 'type',
        },
      };
      pwLockDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0x57a62003daeab9d54aa29b944fc3b451213a5ebdf2e232216a3cfed0dde61b38',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63',
          hashType: 'type',
        },
      };
      const PATH_XUDT_DEP = pathFromProjectRoot('/offchain-modules/deps/xudt_rce');
      const xudtBin = fs.readFileSync(PATH_XUDT_DEP);
      logger.info('deploying xudtDep');
      xudtDep = await ckbDeployGenerator.deployContract(xudtBin, ckbPrivateKey);
    } else if (env === 'AGGRON4') {
      sudtDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0xe12877ebd2c3c364dc46c5c992bcfaf4fee33fa13eebdf82c591fc9825aab769',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0xc5e5dcf215925f7ef4dfaf5f4b4f105bc321c02776d6e7d52a1db3fcd9d011a4',
          hashType: 'type',
        },
      };
      pwLockDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0x57a62003daeab9d54aa29b944fc3b451213a5ebdf2e232216a3cfed0dde61b38',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63',
          hashType: 'type',
        },
      };
      xudtDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0xe12877ebd2c3c364dc46c5c992bcfaf4fee33fa13eebdf82c591fc9825aab769',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0xc5e5dcf215925f7ef4dfaf5f4b4f105bc321c02776d6e7d52a1db3fcd9d011a4',
          hashType: 'type',
        },
      };
    } else {
      throw new Error(`wrong env: ${env}`);
    }
    const contractsDeps = await ckbDeployGenerator.deployContracts(
      {
        bridgeLockscript: fs.readFileSync(PATH_BRIDGE_LOCKSCRIPT),
        recipientTypescript: fs.readFileSync(PATH_RECIPIENT_TYPESCRIPT),
      },
      ckbPrivateKey,
    );
    logger.info('deps', { contractsDeps, sudtDep });
    ckbDeps = {
      xudtType: xudtDep,
      sudtType: sudtDep,
      pwLock: pwLockDep,
      ...contractsDeps,
    };
  }
  const publicKeyHashes = verifierConfigs.map((vc) => vc.btcPublicKey);
  const btcRpc = new RPCClient(clientParams);
  const multisigCollectAddress = await btcRpc.createmultisig({
    nrequired: MULTISIG_THRESHOLD,
    keys: publicKeyHashes,
    address_type: 'p2sh-segwit',
  });

  let assetWhiteListPath: string;
  if (env === 'DEV') {
    assetWhiteListPath = pathFromProjectRoot('/configs/devnet-asset-white-list.json');
  } else if (env === 'AGGRON4') {
    assetWhiteListPath = pathFromProjectRoot('/configs/testnet-asset-white-list.json');
  } else {
    throw new Error(`wrong env: ${env}`);
  }
  const assetWhiteList: WhiteListEthAsset[] = JSON.parse(fs.readFileSync(assetWhiteListPath, 'utf8'));
  const multisigConfig = {
    threshold: MULTISIG_THRESHOLD,
    verifiers: verifierConfigs,
  };
  // get start height
  const delta = 1;
  const btcStartHeight = (await btcRpc.getchaintips()[0]) - delta;
  const ckb = new CKB(CKB_RPC_URL);
  const ckbStartHeight = Number(await ckb.rpc.getTipBlockNumber()) - delta;
  logger.debug('start height', { btcStartHeight, ckbStartHeight });
  const data = {
    multisigCollectAddress,
    assetWhiteList,
    ckbDeps: ckbDeps!,
    multisigConfig,
    ckbStartHeight,
    btcStartHeight,
    ckbPrivateKey,
  };
  if (cachePath) {
    writeJsonToFile(data, cachePath);
  }
  return data;
}
