import { utils, helpers, Script } from '@ckb-lumos/lumos';
import { ForceBridgeCore } from '@force-bridge/x/dist/core';
import { BtcDb } from '@force-bridge/x/dist/db';
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
    this.#btcChain = new BTCChain();
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

  generateBridgeOutNervosTransaction: <T extends Required<NetworkBase>>(
    payload: GenerateBridgeOutNervosTransactionPayload,
  ) => Promise<GenerateTransactionResponse<T>>;

  sendSignedTransaction: <T extends NetworkBase>(payload: SignedTransactionPayload<T>) => Promise<TransactionIdent>;

  getBridgeTransactionStatus: (
    payload: GetBridgeTransactionStatusPayload,
  ) => Promise<GetBridgeTransactionStatusResponse>;

  getMinimalBridgeAmount: (payload: GetMinimalBridgeAmountPayload) => Promise<GetMinimalBridgeAmountResponse>;

  getBridgeInNervosBridgeFee: (
    payload: GetBridgeInNervosBridgeFeePayload,
  ) => Promise<GetBridgeInNervosBridgeFeeResponse>;

  getBridgeOutNervosBridgeFee: (
    payload: GetBridgeOutNervosBridgeFeePayload,
  ) => Promise<GetBridgeOutNervosBridgeFeeResponse>;

  getBridgeTransactionSummaries: (
    payload: GetBridgeTransactionSummariesPayload<XChainNetWork>,
  ) => Promise<TransactionSummaryWithStatus[]>;

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
