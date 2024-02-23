import { BI, Script, utils } from '@ckb-lumos/lumos';
import { Asset, BtcAsset, EosAsset, EthAsset, TronAsset } from '@force-bridge/x/dist/ckb/model/asset';
import { getOwnerTypeHash } from '@force-bridge/x/dist/ckb/tx-helper/multisig/multisig_helper';
import { ForceBridgeCore } from '@force-bridge/x/dist/core';
import { LockRecord, UnlockRecord } from '@force-bridge/x/dist/db/model';
import { logger } from '@force-bridge/x/dist/utils/logger';
import {
  BridgeTransactionStatus,
  TransactionSummary,
  TransactionSummaryWithStatus,
  XChainNetWork,
} from '../types/apiv1';

export const transferDbRecordToResponse = (
  XChainNetwork: XChainNetWork,
  record: LockRecord | UnlockRecord,
): TransactionSummaryWithStatus => {
  let bridgeTxRecord: TransactionSummary;
  if ('lock_hash' in record) {
    const confirmStatus = record.lock_confirm_status === 'confirmed' ? 'confirmed' : record.lock_confirm_number;
    const bridgeFee = new EthAsset(record.asset).getBridgeFee('in');
    const mintAmount =
      record.mint_amount === null ? BI.from(record.lock_amount).sub(BI.from(bridgeFee)).toString() : record.mint_amount;
    bridgeTxRecord = {
      txSummary: {
        fromAsset: {
          network: XChainNetwork,
          ident: record.asset,
          amount: record.lock_amount,
        },
        toAsset: {
          network: 'Nervos',
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ident: getTokenShadowIdent(XChainNetwork, record.asset)!,
          amount: mintAmount,
        },
        sender: record.sender,
        recipient: record.recipient,
        fromTransaction: {
          txId: record.lock_hash,
          timestamp: record.lock_time,
          confirmStatus: confirmStatus,
        },
      },
    };
    if (record.mint_hash) {
      bridgeTxRecord.txSummary.toTransaction = { txId: record.mint_hash, timestamp: record.mint_time };
    }
  } else if ('burn_hash' in record) {
    const confirmStatus = record.burn_confirm_status === 'confirmed' ? 'confirmed' : record.burn_confirm_number;
    const bridgeFee = new EthAsset(record.asset).getBridgeFee('out');
    const unlockAmount =
      record.unlock_amount === null
        ? BI.from(record.burn_amount).sub(BI.from(bridgeFee)).toString()
        : record.unlock_amount;
    bridgeTxRecord = {
      txSummary: {
        fromAsset: {
          network: 'Nervos',
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ident: getTokenShadowIdent(XChainNetwork, record.asset)!,
          amount: record.burn_amount,
        },
        toAsset: {
          network: XChainNetwork,
          ident: record.asset,
          amount: unlockAmount,
        },
        sender: record.sender,
        recipient: record.recipient,
        fromTransaction: {
          txId: record.burn_hash,
          timestamp: record.burn_time,
          confirmStatus: confirmStatus,
        },
      },
    };
    if (record.unlock_hash) {
      bridgeTxRecord.txSummary.toTransaction = { txId: record.unlock_hash, timestamp: record.unlock_time };
    }
  } else {
    throw new Error(`the params record ${JSON.stringify(record, null, 2)} is unexpect`);
  }
  let txSummaryWithStatus: TransactionSummaryWithStatus;
  switch (record.status) {
    case null:
    case 'todo':
    case 'pending':
      txSummaryWithStatus = { txSummary: bridgeTxRecord.txSummary, status: BridgeTransactionStatus.Pending };
      break;
    case 'success':
      txSummaryWithStatus = { txSummary: bridgeTxRecord.txSummary, status: BridgeTransactionStatus.Successful };
      break;
    case 'error':
      txSummaryWithStatus = {
        txSummary: bridgeTxRecord.txSummary,
        message: record.message,
        status: BridgeTransactionStatus.Failed,
      };
      break;
    default:
      throw new Error(`${record.status} which mean the tx status is unexpect`);
  }
  return txSummaryWithStatus;
};

function getTokenShadowIdent(XChainNetwork: XChainNetWork, XChainToken: string): string | undefined {
  let bridgeCellLockscript: Script;
  const ownerTypeHash = getOwnerTypeHash();
  let asset: Asset;
  switch (XChainNetwork) {
    case 'Bitcoin':
      asset = new BtcAsset('btc', ownerTypeHash);
      bridgeCellLockscript = {
        codeHash: ForceBridgeCore.config.ckb.deps.xudtType.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.xudtType.script.hashType,
        args: asset.toBridgeLockscriptArgs(),
      };
      break;
    case 'EOS':
      asset = new EosAsset(XChainToken, ownerTypeHash);
      bridgeCellLockscript = {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
        args: asset.toBridgeLockscriptArgs(),
      };
      break;
    case 'Ethereum':
      asset = new EthAsset(XChainToken, ownerTypeHash);
      bridgeCellLockscript = {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
        args: asset.toBridgeLockscriptArgs(),
      };
      break;
    case 'Tron':
      asset = new TronAsset(XChainToken, ownerTypeHash);
      bridgeCellLockscript = {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
        args: asset.toBridgeLockscriptArgs(),
      };
      break;
    default:
      logger.warn(`chain type is ${XChainNetwork} which not support yet.`);
      return;
  }

  return utils.computeScriptHash(bridgeCellLockscript);
}
