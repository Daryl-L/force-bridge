import fs from 'fs';
import path from 'path';
import { ValInfos } from '@force-bridge/cli/src/changeVal';
import { KeyStore } from '@force-bridge/keystore/dist';
import { OwnerCellConfig } from '@force-bridge/x/dist/ckb/tx-helper/deploy';
import { Config, WhiteListEthAsset, CkbDeps } from '@force-bridge/x/dist/config';
import { asyncSleep, privateKeyToCkbPubkeyHash, writeJsonToFile } from '@force-bridge/x/dist/utils';
import { logger, initLog } from '@force-bridge/x/dist/utils/logger';
import * as lodash from 'lodash';
import * as shelljs from 'shelljs';
import { execShellCmd, pathFromProjectRoot } from './utils';
import { deployDev } from './utils/deploy';
import { ethBatchTest } from './utils/eth_batch_test';
import { genRandomVerifierConfig } from './utils/generate';
import { rpcTest } from './utils/rpc-ci';
import { deployBTCDev } from './utils/deploy_btc';
import { btcBatchTest } from './utils/btc_batch_test';
import { rpcTestBTC } from './utils/rpc-ci-btc';

export interface VerifierConfig {
  privkey: string;
  ckbAddress: string;
  ckbPubkeyHash: string;
  ethAddress: string;
  btcPublicKey: string;
}

export interface MultisigConfig {
  threshold: number;
  verifiers: VerifierConfig[];
}

async function handleDb(action: 'create' | 'drop', MULTISIG_NUMBER: number) {
  if (action === 'create') {
    for (let i = 0; i < MULTISIG_NUMBER; i++) {
      await execShellCmd(
        `docker exec docker_mysql_1 bash -c "mysql -uroot -proot -e 'create database verifier${i + 1}'";`,
      );
    }
    await execShellCmd(
      `docker exec docker_mysql_1 bash -c "mysql -uroot -proot -e 'create database collector; create database watcher; show databases;'";`,
    );
  } else {
    for (let i = 0; i < MULTISIG_NUMBER; i++) {
      await execShellCmd(
        `docker exec docker_mysql_1 bash -c "mysql -uroot -proot -e 'drop database if exists verifier${i + 1}'";`,
      );
    }
    await execShellCmd(
      `docker exec docker_mysql_1 bash -c "mysql -uroot -proot -e 'drop database if exists collector; drop database if exists watcher; show databases;'";`,
    );
  }
}

async function generateConfig(
  initConfig: Config,
  assetWhiteList: WhiteListEthAsset[],
  ckbDeps: CkbDeps,
  multisigConfig: MultisigConfig,
  extraMultiSigConfig: MultisigConfig,
  ckbStartHeight: number,
  btcStartHeight: number,
  configPath: string,
  BTC_PRIVATE_KEY: string,
  CKB_PRIVATE_KEY: string,
  password: string,
  sudtSize = 200,
) {
  const baseConfig: Config = lodash.cloneDeep(initConfig);
  logger.debug(`baseConfig: ${JSON.stringify(baseConfig, null, 2)}`);
  baseConfig.ckb.deps = ckbDeps;
  baseConfig.ckb.startBlockHeight = ckbStartHeight;
  baseConfig.btc.startBlockHeight = btcStartHeight;
  // collector
  const collectorConfig: Config = lodash.cloneDeep(baseConfig);
  collectorConfig.common.role = 'collector';
  collectorConfig.common.orm!.database = 'collector';
  collectorConfig.common.port = 8090;
  collectorConfig.common.collectorPubKeyHash.push(privateKeyToCkbPubkeyHash(CKB_PRIVATE_KEY));
  collectorConfig.btc.privateKey = 'btc';
  collectorConfig.ckb.privateKey = 'ckb';
  collectorConfig.btc.multiSignThreshold = multisigConfig.threshold;
  collectorConfig.btc.multiSignPublicKeys = multisigConfig.verifiers.map((v) => v.btcPublicKey);
  collectorConfig.btc.assetWhiteList = assetWhiteList;
  collectorConfig.ckb.sudtSize = sudtSize;
  collectorConfig.ckb.multisigScript = {
    R: 0,
    M: multisigConfig.threshold,
    publicKeyHashes: multisigConfig.verifiers.map((v) => v.ckbPubkeyHash),
  };
  collectorConfig.collector = {
    gasLimit: 250000,
    batchGasLimit: 100000,
    gasPriceGweiLimit: 2,
    multiCellXchainType: '0x01',
  };
  collectorConfig.btc.multiSignHosts = multisigConfig.verifiers.map((v, i) => {
    return {
      address: v.btcPublicKey,
      host: `http://127.0.0.1:${8000 + i + 1}/force-bridge/sign-server/api/v1`,
    };
  });
  collectorConfig.ckb.multiSignHosts = multisigConfig.verifiers.map((v, i) => {
    return {
      address: v.btcPublicKey,
      host: `http://127.0.0.1:${8000 + i + 1}/force-bridge/sign-server/api/v1`,
    };
  });
  collectorConfig.common.log.logFile = path.join(configPath, 'collector/force_bridge.log');
  collectorConfig.common.log.identity = 'collector';
  collectorConfig.common.keystorePath = path.join(configPath, 'collector/keystore.json');
  const collectorStore = KeyStore.createFromPairs(
    {
      ckb: CKB_PRIVATE_KEY,
      btc: BTC_PRIVATE_KEY,
    },
    password,
  ).getEncryptedData();
  writeJsonToFile(collectorStore, collectorConfig.common.keystorePath);
  writeJsonToFile({ forceBridge: collectorConfig }, path.join(configPath, 'collector/force_bridge.json'));
  // watcher
  const watcherConfig: Config = lodash.cloneDeep(baseConfig);
  watcherConfig.common.role = 'watcher';
  watcherConfig.common.orm!.database = 'watcher';
  watcherConfig.common.log.logFile = path.join(configPath, 'watcher/force_bridge.log');
  watcherConfig.common.log.identity = 'watcher';
  watcherConfig.common.port = 8080;
  watcherConfig.btc.assetWhiteList = assetWhiteList;
  watcherConfig.btc.multiSignPublicKeys = multisigConfig.verifiers.map((v) => v.btcPublicKey);
  watcherConfig.btc.multiSignThreshold = multisigConfig.threshold;
  watcherConfig.ckb.sudtSize = sudtSize;
  writeJsonToFile({ forceBridge: watcherConfig }, path.join(configPath, 'watcher/force_bridge.json'));
  // verifiers
  multisigConfig.verifiers.concat(extraMultiSigConfig.verifiers).map((v, i) => {
    const verifierIndex = i + 1;
    const verifierConfig: Config = lodash.cloneDeep(baseConfig);
    verifierConfig.common.role = 'verifier';
    verifierConfig.common.orm!.database = `verifier${verifierIndex}`;
    verifierConfig.btc.privateKey = 'verifier';
    verifierConfig.ckb.privateKey = 'verifier';
    verifierConfig.common.port = 8000 + verifierIndex;
    verifierConfig.common.collectorPubKeyHash.push(privateKeyToCkbPubkeyHash(CKB_PRIVATE_KEY));
    verifierConfig.common.log.logFile = path.join(configPath, `verifier${verifierIndex}/force_bridge.log`);
    verifierConfig.common.log.identity = `verifier${verifierIndex}`;
    verifierConfig.common.keystorePath = path.join(configPath, `verifier${verifierIndex}/keystore.json`);
    const verifierStore = KeyStore.createFromPairs(
      {
        verifier: v.privkey,
      },
      password,
    ).getEncryptedData();
    writeJsonToFile(verifierStore, verifierConfig.common.keystorePath);
    writeJsonToFile(
      { forceBridge: verifierConfig },
      path.join(configPath, `verifier${verifierIndex}/force_bridge.json`),
    );
  });
  // docker compose file
}

async function startVerifierService(
  FORCE_BRIDGE_KEYSTORE_PASSWORD: string,
  forcecli: string,
  configPath: string,
  MULTISIG_NUMBER: number,
) {
  for (let i = 1; i <= MULTISIG_NUMBER; i++) {
    await execShellCmd(
      `FORCE_BRIDGE_KEYSTORE_PASSWORD=${FORCE_BRIDGE_KEYSTORE_PASSWORD} ${forcecli} verifier -cfg ${configPath}/verifier${i}/force_bridge.json`,
      false,
    );
  }
}

async function startRPCService(FORCE_BRIDGE_KEYSTORE_PASSWORD: string, forcecli: string, configPath: string) {
  await execShellCmd(
    `FORCE_BRIDGE_KEYSTORE_PASSWORD=${FORCE_BRIDGE_KEYSTORE_PASSWORD} ${forcecli} rpc -cfg ${path.join(
      configPath,
      'watcher/force_bridge.json',
    )}`,
    false,
  );
}

async function startCollectorService(FORCE_BRIDGE_KEYSTORE_PASSWORD: string, forcecli: string, configPath: string) {
  await execShellCmd(
    `FORCE_BRIDGE_KEYSTORE_PASSWORD=${FORCE_BRIDGE_KEYSTORE_PASSWORD} ${forcecli} collector -cfg ${configPath}/collector/force_bridge.json`,
    false,
  );
}

async function main() {
  initLog({ level: 'debug', identity: 'integration' });
  logger.info('start integration test');

  // used for deploy and run service
  const BTC_PRIVATE_KEY = '0xc4ad657963930fbff2e9de3404b30a4e21432c89952ed430b56bf802945ed37a';
  const CKB_PRIVATE_KEY = '0xa800c82df5461756ae99b5c6677d019c98cc98c7786b80d7b2e77256e46ea1fe';
  // used for test
  const BTC_TEST_PRIVKEY = '0x719e94ec5d2ecef67b5878503ffd6e1e0e2fe7a52ddd55c436878cb4d52d376d';
  const CKB_TEST_PRIVKEY = '0xa6b8e0cbadda5c0d91cf82d1e8d8120b755aa06bc49030ca6e8392458c65fc80';

  const MULTISIG_NUMBER = 2;
  const MULTISIG_THRESHOLD = 2;
  const EXTRA_MULTISIG_NUMBER = 3;
  const FORCE_BRIDGE_KEYSTORE_PASSWORD = '123456';
  const ETH_RPC_URL = 'http://127.0.0.1:8545';
  const CKB_RPC_URL = 'http://127.0.0.1:8114';
  const CKB_INDEXER_URL = 'http://127.0.0.1:8114';
  const FORCE_BRIDGE_URL = 'http://127.0.0.1:8080/force-bridge/api/v1';
  const BTC_CLIENT_PARAMS = {
    protocol: 'http:',
    url: 'http://127.0.0.1',
    user: 'test',
    pass: 'test',
    port: 18443,
    timeout: 10000,
  };

  const configPath = pathFromProjectRoot('workdir/integration');
  const offchainModulePath = pathFromProjectRoot('offchain-modules');
  const tsnodePath = path.join(offchainModulePath, 'node_modules/.bin/ts-node');
  const forcecli = `${tsnodePath} ${offchainModulePath}/packages/app-cli/src/index.ts`;

  const initConfig = {
    common: {
      log: {
        level: 'info',
      },
      lumosConfigType: 'DEV',
      network: 'testnet',
      role: 'watcher',
      orm: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'root',
        database: 'forcebridge',
        timezone: 'Z',
        synchronize: true,
        logging: false,
      },
      openMetric: true,
      collectorPubKeyHash: [],
    },
    btc: {
      network: 'testnet',
      confirmNumber: 1,
      startBlockHeight: 1,
      clientParams: {
        url: 'http://127.0.0.1',
        user: 'test',
        pass: 'test',
        port: 18443,
        timeout: 10000,
      },
    },
    ckb: {
      ckbRpcUrl: 'http://127.0.0.1:8114',
      ckbIndexerUrl: 'http://127.0.0.1:8114',
      startBlockHeight: 1,
      confirmNumber: 1,
    },
  };
  const { assetWhiteList, ckbDeps, multisigConfig, ckbStartHeight, btcStartHeight } = await deployBTCDev(
    BTC_CLIENT_PARAMS,
    CKB_RPC_URL,
    CKB_INDEXER_URL,
    MULTISIG_NUMBER,
    MULTISIG_THRESHOLD,
    CKB_PRIVATE_KEY,
    'DEV',
    path.join(configPath, 'deployConfig.json'),
  );

  const extraMultiSigConfig = {
    threshold: EXTRA_MULTISIG_NUMBER,
    verifiers: lodash.range(EXTRA_MULTISIG_NUMBER).map((_i) => genRandomVerifierConfig()),
  };
  logger.info(`extra multiSig config ${JSON.stringify(extraMultiSigConfig, null, 2)}`);
  await generateConfig(
    (initConfig as unknown) as Config,
    assetWhiteList,
    ckbDeps,
    multisigConfig,
    extraMultiSigConfig,
    ckbStartHeight,
    btcStartHeight,
    configPath,
    BTC_PRIVATE_KEY,
    CKB_PRIVATE_KEY,
    FORCE_BRIDGE_KEYSTORE_PASSWORD,
  );
  await handleDb('drop', MULTISIG_NUMBER + EXTRA_MULTISIG_NUMBER);
  await handleDb('create', MULTISIG_NUMBER + EXTRA_MULTISIG_NUMBER);
  // await startVerifierService(
  //   FORCE_BRIDGE_KEYSTORE_PASSWORD,
  //   forcecli,
  //   configPath,
  //   MULTISIG_NUMBER + EXTRA_MULTISIG_NUMBER,
  // );
  await startRPCService(FORCE_BRIDGE_KEYSTORE_PASSWORD, forcecli, configPath);
  const command = `FORCE_BRIDGE_KEYSTORE_PASSWORD=${FORCE_BRIDGE_KEYSTORE_PASSWORD} ${forcecli} collector -cfg ${configPath}/collector/force_bridge.json`;
  await asyncSleep(60000);
  const collectorProcess = shelljs.exec(command, { async: true });
  // await btcBatchTest(BTC_TEST_PRIVKEY, CKB_TEST_PRIVKEY, CKB_RPC_URL, CKB_INDEXER_URL, FORCE_BRIDGE_URL, 3);
  console.log(FORCE_BRIDGE_URL);
  await rpcTestBTC(FORCE_BRIDGE_URL, CKB_RPC_URL, CKB_TEST_PRIVKEY, BTC_TEST_PRIVKEY);
  // logger.info('integration test pass!');
  // // only test change validator when the env is set
  // if (!process.env.TEST_CHANGE_VALIDATOR) {
  //   return;
  // }
  collectorProcess.kill();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`integration test failed, error: ${error.stack}`);
    process.exit(1);
  });
