import { utils, helpers, Script, BI } from '@ckb-lumos/lumos';
import { BtcAsset } from '@force-bridge/x/dist/ckb/model/asset';
import { CkbTxGenerator } from '@force-bridge/x/dist/ckb/tx-helper/generator';
import { ForceBridgeCore } from '@force-bridge/x/dist/core';
import { BtcDb } from '@force-bridge/x/dist/db';
import { LockRecord, UnlockRecord } from '@force-bridge/x/dist/db/model';
import { BTCChain } from '@force-bridge/x/dist/xchain/btc';
import { Connection } from 'typeorm';
import { AssetType, NetworkBase, RequiredAsset } from './types';
import {
  ForceBridgeAPIV1,
  GenerateBridgeInTransactionPayload,
  GenerateBridgeOutNervosTransactionPayload,
  GenerateTransactionResponse,
  GetBalancePayload,
  GetBalanceResponse,
  GetBridgeConfigResponse,
  GetBridgeInNervosBridgeFeePayload,
  GetBridgeInNervosBridgeFeeResponse,
  GetBridgeOutNervosBridgeFeePayload,
  GetBridgeOutNervosBridgeFeeResponse,
  GetBridgeTransactionStatusPayload,
  GetBridgeTransactionStatusResponse,
  GetBridgeTransactionSummariesPayload,
  GetMinimalBridgeAmountPayload,
  GetMinimalBridgeAmountResponse,
  LoginPayload,
  LoginResponse,
  SignedTransactionPayload,
  TransactionIdent,
  TransactionSummaryWithStatus,
  XChainNetWork,
} from './types/apiv1';
import { btcBalance, nervosBalance } from './utils/balance';
import { transferDbRecordToResponse } from './utils/helper';

const isJoyId = (lock: Script) => {
  return (
    ForceBridgeCore.config.ckb.deps.joyId && lock.codeHash === ForceBridgeCore.config.ckb.deps.joyId.script.codeHash
  );
};

export class BTCAPI implements ForceBridgeAPIV1 {
  #connection: Connection;
  #dbHandler: BtcDb;
  #btcChain: BTCChain;

  constructor(conn: Connection) {
    this.#connection = conn;
    this.#dbHandler = new BtcDb(this.#connection);
    this.#btcChain = new BTCChain(this.#dbHandler);
  }

  login = async (payload: LoginPayload): Promise<LoginResponse> => {
    const { ckbAddress } = payload;
    const lock = helpers.parseAddress(ckbAddress);
    if (isJoyId(lock)) {
      throw new Error('invalid ckb address or lockscript not support');
    }

    const lockHash = utils.computeScriptHash(lock);
    const account = await this.#dbHandler.getBtcAccountByCkbAddress(ckbAddress, lockHash);
    if (account) {
      const { ckbAddress, btcAddress: xchainAddress } = account;
      return { ckbAddress, xchainAddress };
    }

    const { address: btcAddress } = await this.#btcChain.createMultisigAddressFromCKBLockscript(lock);
    await this.#dbHandler.createBtcAccount(ckbAddress, btcAddress, lockHash);

    return {
      ckbAddress,
      xchainAddress: btcAddress,
    };
  };

  generateBridgeInNervosTransaction: <T extends Required<NetworkBase>>(
    payload: GenerateBridgeInTransactionPayload,
  ) => Promise<GenerateTransactionResponse<T>>;

  generateBridgeOutNervosTransaction = async <T extends Required<NetworkBase>>(
    payload: GenerateBridgeOutNervosTransactionPayload,
  ): Promise<GenerateTransactionResponse<T>> => {
    const { sender, recipient, asset, amount } = payload;
    const ckbTxGenerator = new CkbTxGenerator(
      ForceBridgeCore.config.ckb.ckbRpcUrl,
      ForceBridgeCore.config.ckb.ckbIndexerUrl,
    );

    return {
      network: 'Nervos',
      rawTransaction: await ckbTxGenerator.burnBTC(
        helpers.parseAddress(sender),
        recipient,
        new BtcAsset(asset),
        BI.from(amount),
      ),
    };
  };

  sendSignedTransaction: <T extends NetworkBase>(payload: SignedTransactionPayload<T>) => Promise<TransactionIdent>;

  getBridgeTransactionStatus: (
    payload: GetBridgeTransactionStatusPayload,
  ) => Promise<GetBridgeTransactionStatusResponse>;

  getMinimalBridgeAmount = async (payload: GetMinimalBridgeAmountPayload): Promise<GetMinimalBridgeAmountResponse> => {
    const { xchainAssetIdent } = payload;
    const asset = ForceBridgeCore.config.btc.assetWhiteList.find((asset) => asset.address === xchainAssetIdent);
    if (!asset) {
      throw new Error('minimal amount not configured');
    }

    return {
      minimalAmount: asset.minimalBridgeAmount,
    };
  };

  getBridgeInNervosBridgeFee: (
    payload: GetBridgeInNervosBridgeFeePayload,
  ) => Promise<GetBridgeInNervosBridgeFeeResponse>;

  getBridgeOutNervosBridgeFee: (
    payload: GetBridgeOutNervosBridgeFeePayload,
  ) => Promise<GetBridgeOutNervosBridgeFeeResponse>;

  getBridgeTransactionSummaries = async (
    payload: GetBridgeTransactionSummariesPayload<XChainNetWork>,
  ): Promise<TransactionSummaryWithStatus[]> => {
    const { user, xchainAssetIdent, network } = payload;
    const { ident, network: userNetwork } = user;
    const dbHandler = new BtcDb(this.#connection);
    let lockRecords: LockRecord[] = [];
    let unlockRecords: UnlockRecord[] = [];
    switch (userNetwork) {
      case 'Bitcoin':
        lockRecords = await dbHandler.getLockRecordsByCkbAddress(ident, xchainAssetIdent);
        unlockRecords = await dbHandler.getUnlockRecordsByCkbAddress(ident, xchainAssetIdent);
        break;
      case 'Nervos':
        lockRecords = await dbHandler.getLockRecordsByCkbAddress(ident, xchainAssetIdent);
        unlockRecords = await dbHandler.getUnlockRecordsByCkbAddress(ident, xchainAssetIdent);
        break;
      default:
        throw new Error('invalid address chain type');
    }
    return lockRecords
      .map((lockRecord) => transferDbRecordToResponse(network, lockRecord))
      .concat(unlockRecords.map((unlockRecord) => transferDbRecordToResponse(network, unlockRecord)));
  };

  getAssetList: (name?: string | undefined) => Promise<RequiredAsset<'info'>[]>;

  getBalance = async (payload: GetBalancePayload): Promise<GetBalanceResponse> => {
    const balanceFutures: Promise<AssetType>[] = [];
    for (const { network, userIdent, assetIdent } of payload) {
      switch (network) {
        case 'Bitcoin':
          balanceFutures.push(btcBalance(userIdent));
          break;
        case 'Nervos':
          balanceFutures.push(nervosBalance(userIdent, assetIdent));
          break;
        default:
          continue;
      }
    }

    return ((await Promise.all(balanceFutures)) as unknown) as Promise<GetBalanceResponse>;
  };

  getBridgeConfig: () => Promise<GetBridgeConfigResponse>;
}
