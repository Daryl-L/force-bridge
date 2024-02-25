import { utils } from '@ckb-lumos/base';
import { WitnessArgs } from '@ckb-lumos/base/lib/blockchain';
import { IndexerTransaction, ScriptType, SearchKey } from '@ckb-lumos/ckb-indexer/src/type';
import { number, bytes } from '@ckb-lumos/codec';
import { bytify } from '@ckb-lumos/codec/lib/bytes';
import { serializeMultisigScript } from '@ckb-lumos/common-scripts/lib/secp256k1_blake160_multisig';
import { key } from '@ckb-lumos/hd';
import {
  encodeToAddress,
  sealTransaction,
  TransactionSkeletonType,
  transactionSkeletonToObject,
} from '@ckb-lumos/helpers';

import { BI } from '@ckb-lumos/lumos';
import { RPC } from '@ckb-lumos/rpc';
import { BigNumber } from 'bignumber.js';
import * as lodash from 'lodash';
import { BtcAsset, ChainType, EosAsset, EthAsset, getAsset, TronAsset } from '../ckb/model/asset';
import { BTCRecipientCellData } from '../ckb/tx-helper/generated/btc/btc_recipient_cell';
import { BurnCTMeta } from '../ckb/tx-helper/generated/btc/burn_ctmeta';
import { BTCMintWitness } from '../ckb/tx-helper/generated/btc/mint_witness';
import { EthRecipientCellData } from '../ckb/tx-helper/generated/eth/eth_recipient_cell';
import { ForceBridgeLockscriptArgs } from '../ckb/tx-helper/generated/force_bridge_lockscript';
import { MintWitness } from '../ckb/tx-helper/generated/mint_witness';
import { RecipientCellData } from '../ckb/tx-helper/generated/recipient_cell';
import { CkbTxGenerator, MintAssetRecord } from '../ckb/tx-helper/generator';
import { getOwnerTypeHash } from '../ckb/tx-helper/multisig/multisig_helper';
import { forceBridgeRole } from '../config';
import { ForceBridgeCore } from '../core';
import { CkbDb, KVDb } from '../db';
import { CollectorCkbMint } from '../db/entity/CkbMint';
import { ICkbBurn, ICkbMint, IEthUnlock, MintedRecord, MintedRecords } from '../db/model';
import { asserts, nonNullable } from '../errors';
import { BridgeMetricSingleton, txTokenInfo } from '../metric/bridge-metric';
import { createAsset, MultiSigMgr } from '../multisig/multisig-mgr';
import {
  asyncSleep,
  foreverPromise,
  fromHexString,
  toHexString,
  transactionSkeletonToJSON,
  uint8ArrayToString,
} from '../utils';
import { logger } from '../utils/logger';
import { getCachedAssetAVGPrice } from '../utils/price';
import { getAssetTypeByAsset } from '../xchain/tron/utils';
import Transaction = CKBComponents.Transaction;
import TransactionWithStatus = CKBComponents.TransactionWithStatus;

const lastHandleCkbBlockKey = 'lastHandleCkbBlock';

export interface CkbTxInfo {
  info: IndexerTransaction;
  tx: TransactionWithStatus;
}

// CKB handler
// 1. Listen CKB chain to get new burn events.
// 2. Listen database to get new mint events, send tx.
export class CkbHandler {
  private ckb = ForceBridgeCore.ckb;
  private ckbIndexer = ForceBridgeCore.ckbIndexer;
  private rpc: RPC;
  private multisigMgr: MultiSigMgr;
  private lastHandledBlockHeight: number;
  private lastHandledBlockHash: string;
  private startTipBlockHeight: number;

  constructor(private db: CkbDb, private kvDb: KVDb, private role: forceBridgeRole) {
    this.rpc = new RPC(ForceBridgeCore.config.ckb.ckbRpcUrl);
    if (role === 'collector') {
      this.multisigMgr = new MultiSigMgr(
        'CKB',
        ForceBridgeCore.config.ckb.multiSignHosts,
        ForceBridgeCore.config.ckb.multisigScript.M,
      );
    }
  }

  async setStartTipBlockHeight(): Promise<void> {
    this.startTipBlockHeight = (await this.getTipBlock()).height;
  }

  syncedToStartTipBlockHeight(): boolean {
    return (
      Boolean(this.lastHandledBlockHeight) &&
      Boolean(this.startTipBlockHeight) &&
      this.lastHandledBlockHeight > this.startTipBlockHeight
    );
  }

  async getLastHandledBlock(): Promise<{ blockNumber: number; blockHash: string }> {
    const lastHandledBlock = await this.kvDb.get(lastHandleCkbBlockKey);
    if (!lastHandledBlock) {
      return { blockNumber: 0, blockHash: '' };
    }
    const block = lastHandledBlock.split(',');
    return { blockNumber: parseInt(block[0]), blockHash: block[1] };
  }

  async setLastHandledBlock(blockNumber: number, blockHash: string): Promise<void> {
    this.lastHandledBlockHeight = blockNumber;
    this.lastHandledBlockHash = blockHash;
    await this.kvDb.set(lastHandleCkbBlockKey, `${blockNumber},${blockHash}`);
  }

  getHandledBlock(): { height: number; hash: string } {
    return { height: this.lastHandledBlockHeight, hash: this.lastHandledBlockHash };
  }

  async getTipBlock(): Promise<{ height: number; hash: string }> {
    const tipHeader = await this.ckb.rpc.getTipHeader();
    return { height: Number(tipHeader.number), hash: tipHeader.hash };
  }

  async onCkbBurnConfirmed(confirmedCkbBurns: ICkbBurn[]): Promise<void> {
    if (this.role !== 'collector') return;
    for (const burn of confirmedCkbBurns) {
      logger.info(`CkbHandler onCkbBurnConfirmed burnRecord:${JSON.stringify(burn)}`);
      if (BigInt(burn.amount) <= BigInt(burn.bridgeFee))
        throw new Error('Unexpected error: burn amount less than bridge fee');
      const unlockAmount = (BigInt(burn.amount) - BigInt(burn.bridgeFee)).toString();
      const collectorEthUnlock: IEthUnlock = {
        ckbTxHash: burn.ckbTxHash,
        asset: burn.asset,
        amount: unlockAmount,
        recipientAddress: burn.recipientAddress,
      };
      const individualAuditThreshold =
        ForceBridgeCore.config.audit && ForceBridgeCore.config.audit!.individualAuditThreshold
          ? ForceBridgeCore.config.audit!.individualAuditThreshold
          : '100000';
      const asset = ForceBridgeCore.config.eth.assetWhiteList.find((asset) => asset.address === burn.asset);
      if (!asset) throw new Error('asset not in white list');
      const price = await getCachedAssetAVGPrice(asset.symbol);
      if (
        new BigNumber(unlockAmount)
          .multipliedBy(price)
          .div(Math.pow(10, asset.decimal))
          .gt(new BigNumber(individualAuditThreshold))
      ) {
        collectorEthUnlock.status = 'manual-review';
        collectorEthUnlock.message = `Amount of ${unlockAmount} ${asset.symbol} is greater than the threshold of ${individualAuditThreshold}`;
      }
      switch (burn.chain) {
        case ChainType.BTC:
          await this.db.createBtcUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              amount: unlockAmount,
              chain: burn.chain,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        case ChainType.ETH:
          await this.db.createCollectorEthUnlock([collectorEthUnlock]);
          break;
        case ChainType.EOS:
          await this.db.createEosUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              amount: unlockAmount,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        case ChainType.TRON:
          await this.db.createTronUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              assetType: getAssetTypeByAsset(burn.asset),
              amount: unlockAmount,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        default:
          throw new Error(`wrong burn chain type: ${burn.chain}`);
      }
    }
  }

  async initLastHandledBlock(): Promise<void> {
    const lastHandledBlock = await this.getLastHandledBlock();
    if (lastHandledBlock.blockNumber !== 0) {
      this.lastHandledBlockHeight = lastHandledBlock.blockNumber;
      this.lastHandledBlockHash = lastHandledBlock.blockHash;
      return;
    }

    const lastHandledBlockHeight = ForceBridgeCore.config.ckb.startBlockHeight;
    if (lastHandledBlockHeight > 0) {
      const lastHandledHead = await this.ckb.rpc.getHeaderByNumber(`0x${lastHandledBlockHeight.toString(16)}`);
      if (lastHandledHead) {
        this.lastHandledBlockHeight = Number(lastHandledHead.number);
        this.lastHandledBlockHash = lastHandledHead.hash;
        return;
      } else {
        throw new Error(`ckb node not synced to startBlockHeight ${lastHandledBlockHeight} yet`);
      }
    }

    const currentBlock = await this.ckb.rpc.getTipHeader();
    this.lastHandledBlockHeight = Number(currentBlock.number);
    this.lastHandledBlockHash = currentBlock.hash;
  }

  async watchNewBlock(): Promise<void> {
    await this.setStartTipBlockHeight();
    await this.initLastHandledBlock();
    const maxBatchSize = 5000;
    let currentHeight: number | null = null;
    foreverPromise(
      async () => {
        const blockNumber = await this.ckb.rpc.getTipBlockNumber();
        currentHeight = Number(blockNumber);
        logger.info(`currentHeight: ${currentHeight}, lastHandledBlock: ${this.lastHandledBlockHeight}`);
        if (currentHeight - this.lastHandledBlockHeight < 1) {
          // already handled, wait for new block
          await asyncSleep(8000);
          return;
        }
        const confirmBlockNumber = this.lastHandledBlockHeight - ForceBridgeCore.config.ckb.confirmNumber;
        const startBlockNumber = (confirmBlockNumber < 0 ? 0 : confirmBlockNumber) + 1;
        let endBlockNumber = currentHeight;
        if (currentHeight - this.lastHandledBlockHeight > maxBatchSize) {
          endBlockNumber = this.lastHandledBlockHeight + maxBatchSize;
        }
        asserts(startBlockNumber <= endBlockNumber);
        const block = await this.ckb.rpc.getBlockByNumber(BigInt(endBlockNumber));
        await this.handleTxs(startBlockNumber, endBlockNumber, currentHeight);
        await this.setLastHandledBlock(endBlockNumber, block.header.hash);
        BridgeMetricSingleton.getInstance(this.role).setBlockHeightMetrics('ckb', endBlockNumber, currentHeight);
        logger.info(`CkbHandler onBlock blockHeight:${endBlockNumber} blockHash:${block.header.hash}`);
      },
      {
        onRejectedInterval: 3000,
        onResolvedInterval: 0,
        onRejected: (e: Error) => {
          logger.error(`CKB watchNewBlock blockHeight:${this.lastHandledBlockHeight + 1} error:${e.stack}`);
        },
      },
    );
  }

  async getTransactions(searchKey: SearchKey): Promise<CkbTxInfo[]> {
    const GetTransactionRPCResult = await this.ckbIndexer.getTransactions(searchKey);
    const txs = lodash.uniqBy(GetTransactionRPCResult.objects, 'txHash');
    const result: CkbTxInfo[] = [];
    for (const tx of txs) {
      const txWithStatus = await this.ckb.rpc.getTransaction(tx.txHash);
      result.push({
        info: tx,
        tx: txWithStatus,
      });
    }
    return result;
  }

  async handleBTCTx(fromBlockNum: number, toBlockNum: number, currentHeight: number): Promise<void> {
    const txs = await this.getTransactions({
      filter: { blockRange: ['0x' + fromBlockNum.toString(16), '0x' + (toBlockNum + 1).toString(16)] },
      script: ForceBridgeCore.config.btc.btcRecipientLock,
      scriptType: 'lock',
    });

    for (const tx of txs) {
      const burnWitness = BurnCTMeta.fromWitness(tx.tx.transaction.witnesses[0]);
      if (burnWitness) {
        await this.onBurnTx(tx, currentHeight);
      }
      const mintWitness = BTCMintWitness.fromWitness(tx.tx.transaction.witnesses[0]);
      if (mintWitness) {
        const parsedMintRecords = await this.parseBTCMintTx(tx.tx.transaction, Number(tx.info.blockNumber));
        if (parsedMintRecords) {
          await this.onMintTx(currentHeight, parsedMintRecords);
          BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('ckb_mint', 'success');
        }
      }
    }
  }

  async handleTxs(fromBlockNum: number, toBlockNum: number, currentHeight: number): Promise<void> {
    const mintSearchKey: SearchKey = {
      filter: { blockRange: ['0x' + fromBlockNum.toString(16), '0x' + (toBlockNum + 1).toString(16)] },
      script: {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
        args: '0x',
      },
      scriptType: 'lock',
    };
    const burnSearchKey: SearchKey = {
      filter: { blockRange: ['0x' + fromBlockNum.toString(16), '0x' + (toBlockNum + 1).toString(16)] },
      script: {
        codeHash: ForceBridgeCore.config.ckb.deps.recipientType.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.recipientType.script.hashType,
        args: '0x',
      },
      scriptType: 'type',
    };
    const mintTxs = await this.getTransactions(mintSearchKey);
    const burnTxs = await this.getTransactions(burnSearchKey);
    logger.info(
      `CkbHandler onBlock handle logs from ${fromBlockNum} to ${toBlockNum}, mint txs: ${JSON.stringify(
        mintTxs.map((tx) => tx.info.blockNumber),
      )}, burn txs: ${JSON.stringify(burnTxs.map((tx) => tx.tx.transaction.hash))}`,
    );

    for (const tx of mintTxs) {
      const parsedMintRecords = await this.parseMintTx(tx.tx.transaction, Number(tx.info.blockNumber));
      if (parsedMintRecords) {
        await this.onMintTx(Number(tx.info.blockNumber), parsedMintRecords);
        BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('ckb_mint', 'success');
      }
    }

    for (const tx of burnTxs) {
      await this.onBurnTx(tx, currentHeight);
    }
  }

  async onMintTx(blockNumber: number, mintedRecords: MintedRecords): Promise<void> {
    await this.db.watcherCreateMint(blockNumber, mintedRecords);
    await this.db.updateBridgeInRecords(mintedRecords);
    if (this.role === 'collector') {
      await this.db.updateCollectorCkbMintStatus(blockNumber, mintedRecords.txHash, 'success');
    }
  }

  async onBurnTx(txInfo: CkbTxInfo, currentHeight: number): Promise<void> {
    const tx = txInfo.tx.transaction;
    const txHash = txInfo.tx.transaction.hash;
    const records = await this.db.getCkbBurnByTxHashes([txHash]);
    if (records.length > 1) {
      logger.error('unexpected db find error', records);
      throw new Error(`unexpected db find error, records.length = ${records.length}`);
    }
    const blockNumber = Number(txInfo.info.blockNumber);
    const confirmedNumber = currentHeight - blockNumber;
    const confirmed = confirmedNumber >= ForceBridgeCore.config.ckb.confirmNumber;
    const confirmStatus = confirmed ? 'confirmed' : 'unconfirmed';
    logger.info(`handle burn tx ${txHash}, confirmed number: ${confirmedNumber}, confirmed: ${confirmed}`);
    // create new CkbBurn record
    let unlockRecords = records;
    if (records.length === 0) {
      let cellData: RecipientCellData | null = null;
      if (ForceBridgeCore.config.eth) {
        cellData = await parseBurnTx(tx);
      } else if (ForceBridgeCore.config.btc) {
        cellData = await parseBTCBurnTx(tx);
      }
      if (cellData === null) {
        return;
      }
      const previousOutput = nonNullable(tx.inputs[0].previousOutput);
      const burnPreviousTx: TransactionWithStatus = await this.ckb.rpc.getTransaction(previousOutput.txHash);
      const senderLockscript = burnPreviousTx.transaction.outputs[Number(previousOutput.index)].lock;
      const senderAddress = encodeToAddress({
        codeHash: senderLockscript.codeHash,
        hashType: senderLockscript.hashType,
        args: senderLockscript.args,
      });
      const data: BurnDbData = {
        senderAddress: senderAddress,
        cellData: cellData,
      };
      const chain = data.cellData.getChain();
      const asset = data.cellData.getAsset();
      const burn: ICkbBurn = {
        senderAddress: data.senderAddress,
        ckbTxHash: txHash,
        asset: asset,
        bridgeFee: '0',
        chain,
        amount: data.cellData.getAmount().toString(),
        recipientAddress: data.cellData.getRecipientAddress(),
        blockNumber: Number(txInfo.info.blockNumber),
        confirmNumber: confirmedNumber,
        confirmStatus,
      };
      if (burn.recipientAddress.length > 10240 || burn.senderAddress.length > 10240) {
        logger.warn(
          `skip createCkbBurn for record ${JSON.stringify(
            burn,
          )}, reason: recipientAddress or senderAddress too long to fit in database`,
        );
        return;
      }
      await this.db.createCkbBurn([burn]);
      await this.db.updateBurnBridgeFee([burn]);
      unlockRecords = [burn];
      BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('ckb_burn', 'success');
      BridgeMetricSingleton.getInstance(this.role).addBridgeTokenMetrics('ckb_burn', [
        {
          token: burn.asset,
          amount: Number(burn.amount),
        },
      ]);
      logger.info(
        `CkbHandler watchBurnEvents saveBurnEvent success, ckbTxHash:${tx.hash} senderAddress:${senderAddress}`,
      );
    }
    if (records.length === 1) {
      await this.db.updateBurnConfirmNumber([{ txHash, confirmedNumber, confirmStatus }]);
      logger.info(`update burn record ${txHash} status, confirmed number: ${confirmedNumber}, confirmed: ${confirmed}`);
    }
    if (confirmed && this.role === 'collector') {
      const unlockRecord = unlockRecords[0];
      try {
        const asset = getAsset(unlockRecord.chain, unlockRecord.asset);
        const fee = asset.getBridgeFee('out');
        if (BigInt(unlockRecord.amount) <= BigInt(fee)) {
          throw new Error(`unlock record amount ${unlockRecord.amount} low than fee ${fee}`);
        }
        unlockRecord.bridgeFee = fee;
      } catch (e) {
        logger.warn(`fail to get fee to confirm burn, err: ${e.stack}`);
        return;
      }
      await this.onCkbBurnConfirmed([unlockRecord]);
      logger.info(`save unlock successful for burn tx ${txHash}`);
    }
  }

  async parseBTCMintTx(tx: Transaction, blockNumber: number): Promise<undefined | MintedRecords> {
    let isInputsContainRecipientCell = false;
    const witness = BTCMintWitness.fromWitness(tx.witnesses[0]);
    if (!witness) {
      return undefined;
    }
    for (const input of tx.inputs) {
      const previousOutput = nonNullable(input.previousOutput);
      const previousHash = previousOutput.txHash;
      const previousTx = await this.ckb.rpc.getTransaction(previousHash);
      if (!previousTx) {
        continue;
      }

      const inputLock = previousTx.transaction.outputs[Number(previousOutput.index)].lock;
      if (
        inputLock.codeHash === ForceBridgeCore.config.btc.btcRecipientLock.codeHash &&
        inputLock.hashType === ForceBridgeCore.config.btc.btcRecipientLock.hashType &&
        inputLock.args === ForceBridgeCore.config.btc.btcRecipientLock.args
      ) {
        isInputsContainRecipientCell = true;
        break;
      }
    }

    if (!isInputsContainRecipientCell) {
      return undefined;
    }

    const mintedXUDTCellIndexes = tx.outputs.reduce((acc, output, index) => {
      if (
        output.type &&
        output.type.codeHash === ForceBridgeCore.config.ckb.deps.xudtType.script.codeHash &&
        output.type.hashType === ForceBridgeCore.config.ckb.deps.xudtType.script.hashType
      ) {
        acc.push(index);
      }

      return acc;
    }, [] as number[]);

    const parsedResult = mintedXUDTCellIndexes.reduce((acc, i) => {
      const amount = number.Uint128LE.unpack(bytes.bytify(tx.outputsData[i]).subarray(0, 16));
      acc.push({
        amount: amount.toBigInt(),
        id: witness.lockIds[i],
        lockTxHash: witness.lockIds[i].split('-')[0],
        lockBlockHeight: blockNumber,
      });

      return acc;
    }, [] as MintedRecord[]);
    return { txHash: tx.hash, records: parsedResult };
  }

  async parseMintTx(tx: Transaction, blockNumber: number): Promise<null | MintedRecords> {
    let isInputsContainBridgeCell = false;
    for (const input of tx.inputs) {
      const previousOutput = nonNullable(input.previousOutput);
      const preHash = previousOutput.txHash;
      const txPrevious = await this.ckb.rpc.getTransaction(preHash);
      if (txPrevious == null) {
        continue;
      }
      const inputLock = txPrevious.transaction.outputs[Number(previousOutput.index)].lock;
      if (
        inputLock.codeHash === ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash &&
        inputLock.hashType === ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType &&
        isTypeIDCorrect(inputLock.args)
      ) {
        isInputsContainBridgeCell = true;
        break;
      }
    }
    if (!isInputsContainBridgeCell) return null;

    const mintedSudtCellIndexes = new Array(0);
    tx.outputs.forEach((output, index) => {
      if (
        output.type &&
        output.type.codeHash === ForceBridgeCore.config.ckb.deps.sudtType.script.codeHash &&
        output.type.hashType === ForceBridgeCore.config.ckb.deps.sudtType.script.hashType
      ) {
        mintedSudtCellIndexes.push(index);
      }
    });
    if (0 === mintedSudtCellIndexes.length) return null;

    const witnessArgs = WitnessArgs.unpack(tx.witnesses[0]);
    const inputTypeWitness = bytify(witnessArgs.inputType ?? '').buffer;
    const mintWitness = new MintWitness(inputTypeWitness, { validate: true });
    const lockTxHashes = mintWitness.getLockTxHashes();
    const parsedResult: MintedRecord[] = [];
    mintedSudtCellIndexes.forEach((value, index) => {
      const amount = utils.readBigUInt128LE(tx.outputsData[value]);
      const mintId = uint8ArrayToString(new Uint8Array(lockTxHashes.indexAt(index).raw()));
      const lockTxHash = mintId.split('-')[0];
      parsedResult.push({ amount: amount, id: mintId, lockTxHash: lockTxHash, lockBlockHeight: blockNumber });
    });
    return { txHash: tx.hash, records: parsedResult };
  }

  handleMintRecords(): void {
    if (this.role !== 'collector') {
      return;
    }
    const ownerTypeHash = getOwnerTypeHash();
    const generator = new CkbTxGenerator(
      ForceBridgeCore.config.ckb.ckbRpcUrl,
      ForceBridgeCore.config.ckb.ckbIndexerUrl,
    );
    this.handleTodoMintRecords(ownerTypeHash, generator);
  }

  async filterMintRecordsWithChainData(records: CollectorCkbMint[]): Promise<CollectorCkbMint[]> {
    const inMintRecords = (await this.db.getCkbMintByIds(records.map((r) => r.id))).map((r) => r.id);
    if (inMintRecords.length > 0) {
      await this.db.setCollectorCkbMintToSuccess(inMintRecords);
      return records.filter((r) => inMintRecords.indexOf(r.id) < 0);
    } else {
      return records;
    }
  }

  handleTodoMintRecords(ownerTypeHash: string, generator: CkbTxGenerator): void {
    foreverPromise(
      async () => {
        if (!this.syncedToStartTipBlockHeight()) {
          logger.info(
            `wait until syncing to startBlockHeight, lastHandledBlockHeight: ${this.lastHandledBlockHeight}, startTipBlockHeight: ${this.startTipBlockHeight}`,
          );
          return;
        }
        const rawMintRecords = await this.db.getCkbMintRecordsToMint('todo');
        // filter using CkbMint from chain
        const mintRecords = await this.filterMintRecordsWithChainData(rawMintRecords);
        if (mintRecords.length == 0) {
          logger.debug('wait for new mint records');
          await asyncSleep(3000);
          return;
        }
        logger.info(`CkbHandler handleMintRecords new mintRecords:${JSON.stringify(mintRecords)}`);
        await this.ckbIndexer.waitForSync();
        await this.doHandleMintRecords(mintRecords, ownerTypeHash, generator);
      },
      {
        onRejectedInterval: 15000,
        onResolvedInterval: 15000,
        onRejected: (e: Error) => {
          logger.error(`CKB handleTodoMintRecords error:${e.stack}`);
        },
      },
    );
  }

  async doHandleMintRecords(mintRecords: ICkbMint[], ownerTypeHash: string, generator: CkbTxGenerator): Promise<void> {
    if (mintRecords.length === 0) {
      return;
    }

    const mintIds = mintRecords
      .map((ckbMint) => {
        return ckbMint.id;
      })
      .join(', ');
    const records = mintRecords.map((r) => this.filterMintRecords(r, ownerTypeHash));
    const newTokens = await this.filterNewTokens(records);
    if (newTokens.length > 0) {
      logger.info(
        `CkbHandler doHandleMintRecords bridge cell is not exist. do create bridge cell. ownerTypeHash: ${ownerTypeHash.toString()}`,
      );
      logger.info(`CkbHandler doHandleMintRecords createBridgeCell newToken`, newTokens);
      await this.ckbIndexer.waitForSync();
      await this.createBridgeCell(newTokens, generator);
    }

    for (;;) {
      try {
        mintRecords.map((r) => {
          r.status = 'pending';
        });
        await this.db.updateCollectorCkbMint(mintRecords);
        await this.ckbIndexer.waitForSync();
        break;
      } catch (e) {
        logger.error(`CkbHandler doHandleMintRecords prepare error:${e.stack}`);
        await asyncSleep(3000);
      }
    }

    logger.info(`mint for records`, records);
    let txSkeleton: TransactionSkeletonType;
    if (ForceBridgeCore.config.eth) {
      txSkeleton = await generator.mint(records);
    } else if (ForceBridgeCore.config.btc) {
      txSkeleton = await generator.mintBTC(records);
    } else {
      throw new Error('config not set');
    }
    logger.debug(`mint tx txSkeleton ${transactionSkeletonToJSON(txSkeleton)}`);
    const sigs = await this.collectMintSignatures(txSkeleton, mintRecords);
    for (;;) {
      try {
        if (typeof sigs === 'boolean' && (sigs as boolean)) {
          mintRecords.map((r) => {
            r.status = 'success';
          });
          break;
        }
        const signatures = sigs as string[];
        if (signatures.length < ForceBridgeCore.config.ckb.multisigScript.M) {
          const mintTxHash = txSkeleton.get('signingEntries').get(1)!.message;
          mintRecords.map((r) => {
            r.status = 'error';
            r.message = `sig number:${signatures.length} less than:${ForceBridgeCore.config.ckb.multisigScript.M}`;
            r.mintHash = mintTxHash;
          });
          logger.error(
            `CkbHandler doHandleMintRecords sig number:${signatures.length} less than:${ForceBridgeCore.config.ckb.multisigScript.M}, mintIds:${mintIds}`,
          );
          break;
        }

        const content0 = key.signRecoverable(
          txSkeleton.get('signingEntries').get(0)!.message,
          ForceBridgeCore.config.ckb.privateKey,
        );
        let content1 = serializeMultisigScript(ForceBridgeCore.config.ckb.multisigScript);
        content1 += signatures.join('');

        logger.info(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
        const tx = sealTransaction(txSkeleton, [content0, content1]);
        const mintTxHash = await this.rpc.sendTransaction(tx, 'passthrough');
        logger.info(
          `CkbHandler doHandleMintRecords Mint Transaction has been sent, ckbTxHash ${mintTxHash}, mintIds:${mintIds}`,
        );

        const txStatus = await this.waitUntilCommitted(mintTxHash, 200);
        if (txStatus && txStatus.txStatus.status === 'committed') {
          const mintTokens: txTokenInfo[] = [];
          mintRecords.map((r) => {
            r.status = 'success';
            r.mintHash = mintTxHash;
            mintTokens.push({
              token: r.asset,
              amount: Number(r.amount),
            });
          });
          BridgeMetricSingleton.getInstance(this.role).addBridgeTokenMetrics('ckb_mint', mintTokens);
        } else {
          logger.error(`CkbHandler doHandleMintRecords mint execute failed, mintIds:${mintIds}`);
          BridgeMetricSingleton.getInstance(this.role).addBridgeTxMetrics('ckb_mint', 'failed');
          mintRecords.map((r) => {
            r.status = 'error';
            r.mintHash = mintTxHash;
            r.message = 'mint execute failed';
          });
        }
        break;
      } catch (e) {
        logger.error(`CkbHandler doHandleMintRecords mint mintIds:${mintIds} error:${e.stack}`);
        await asyncSleep(3000);
      }
    }

    for (;;) {
      try {
        await this.db.updateCollectorCkbMint(mintRecords);
        logger.info('CkbHandler doHandleMintRecords mint execute completed, mintIds:', mintIds);
        break;
      } catch (e) {
        logger.error(`CkbHandler doHandleMintRecords db.updateCkbMint mintIds:${mintIds} error:${e.stack}`);
      }
    }
  }

  async collectMintSignatures(
    txSkeleton: TransactionSkeletonType,
    mintRecords: ICkbMint[],
  ): Promise<string[] | boolean> {
    return await this.multisigMgr.collectSignatures({
      rawData: txSkeleton.get('signingEntries').get(1)!.message,
      payload: {
        sigType: 'mint',
        mintRecords: mintRecords.map((r) => {
          return {
            id: r.id,
            chain: r.chain,
            asset: r.asset,
            amount: r.amount,
            recipientLockscript: r.recipientLockscript,
            sudtExtraData: r.sudtExtraData,
          };
        }),
        txSkeleton: transactionSkeletonToObject(txSkeleton),
      },
    });
  }

  filterMintRecords(r: ICkbMint, ownerTypeHash: string): MintAssetRecord {
    switch (r.chain) {
      case ChainType.BTC:
        return {
          id: r.id,
          asset: new BtcAsset(r.asset, ownerTypeHash),
          recipient: r.recipientLockscript,
          amount: BigInt(r.amount),
          sudtExtraData: r.sudtExtraData,
        };
      case ChainType.ETH:
        return {
          id: r.id,
          asset: new EthAsset(r.asset, ownerTypeHash),
          recipient: r.recipientLockscript,
          amount: BigInt(r.amount),
          sudtExtraData: r.sudtExtraData,
        };
      case ChainType.TRON:
        return {
          id: r.id,
          asset: new TronAsset(r.asset, ownerTypeHash),
          recipient: r.recipientLockscript,
          amount: BigInt(r.amount),
          sudtExtraData: r.sudtExtraData,
        };
      case ChainType.EOS:
        return {
          id: r.id,
          asset: new EosAsset(r.asset, ownerTypeHash),
          recipient: r.recipientLockscript,
          amount: BigInt(r.amount),
          sudtExtraData: r.sudtExtraData,
        };
      default:
        throw new Error('asset not supported!');
    }
  }

  async filterNewTokens(records: MintAssetRecord[]): Promise<MintAssetRecord[]> {
    const newTokens: MintAssetRecord[] = [];
    const assets: string[] = [];
    for (const record of records) {
      if (assets.indexOf(record.asset.toBridgeLockscriptArgs()) != -1) {
        continue;
      }
      assets.push(record.asset.toBridgeLockscriptArgs());

      logger.debug('CkbHandler filterNewTokens record:', record);
      const bridgeCellLockscript = {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
        args: record.asset.toBridgeLockscriptArgs(),
      };
      logger.debug('CkbHandler filterNewTokens bridgeCellLockscript ', bridgeCellLockscript);
      const searchKey = {
        script: bridgeCellLockscript,
        scriptType: 'lock' as ScriptType,
      };
      const bridgeCells = await this.ckbIndexer.getCells(searchKey);
      if (bridgeCells.objects.length == 0) {
        newTokens.push(record);
      }
    }
    return newTokens;
  }

  async createBridgeCell(newTokens: MintAssetRecord[], generator: CkbTxGenerator): Promise<void> {
    const assets: createAsset[] = [];
    const scripts = newTokens.map((r) => {
      assets.push({
        chain: r.asset.chainType,
        asset: r.asset.getAddress(),
      });
      return {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        args: r.asset.toBridgeLockscriptArgs(),
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
      };
    });

    const txSkeleton = await generator.createBridgeCell(scripts);
    const message0 = txSkeleton.get('signingEntries').get(0)!.message;
    const content0 = key.signRecoverable(message0, ForceBridgeCore.config.ckb.privateKey);
    let content1 = serializeMultisigScript(ForceBridgeCore.config.ckb.multisigScript);
    const sigs = await this.multisigMgr.collectSignatures({
      rawData: txSkeleton.get('signingEntries').get(1)!.message,
      payload: {
        sigType: 'create_cell',
        createAssets: assets,
        txSkeleton: transactionSkeletonToObject(txSkeleton),
      },
    });
    const signatures = sigs as string[];
    if (signatures.length < ForceBridgeCore.config.ckb.multisigScript.M) {
      throw new Error(
        `createBridgeCell collect signatures failed, expected:${ForceBridgeCore.config.ckb.multisigScript.M}, collected:${signatures.length}`,
      );
    }
    content1 += signatures.join('');

    const tx = sealTransaction(txSkeleton, [content0, content1]);
    logger.info(`tx: ${JSON.stringify(tx)}`);
    const txHash = await this.rpc.sendTransaction(tx, 'passthrough');
    const txStatus = await this.waitUntilCommitted(txHash, 120);
    if (txStatus === null || txStatus.txStatus.status !== 'committed') {
      throw new Error('fail to createBridgeCell');
    }
  }

  async waitUntilCommitted(txHash: string, timeout: number): Promise<TransactionWithStatus | null> {
    let waitTime = 0;
    let txStatus: TransactionWithStatus | null = null;
    for (;;) {
      try {
        txStatus = await this.ckb.rpc.getTransaction(txHash);
        if (txStatus === null) {
          logger.warn(`CkbHandler waitUntilCommitted tx ${txHash} status: null, index: ${waitTime}`);
          return null;
        }
        logger.debug(
          `CkbHandler waitUntilCommitted tx ${txHash} status: ${txStatus.txStatus.status}, index: ${waitTime}`,
        );
        if (txStatus.txStatus.status === 'committed') {
          return txStatus;
        }
      } catch (e) {
        logger.error(`CkbHandler waitUntilCommitted error:${e.stack}`);
      }
      waitTime += 1;
      if (waitTime >= timeout) {
        return txStatus;
      }
      await asyncSleep(1000);
    }
  }

  start(): void {
    void this.watchNewBlock();
    this.handleMintRecords();
    logger.info('ckb handler started 🚀');
  }
}

function isTypeIDCorrect(args: string): boolean {
  const expectOwnerTypeHash = getOwnerTypeHash();
  const bridgeLockArgs = new ForceBridgeLockscriptArgs(fromHexString(args).buffer);
  const ownerTypeHash = `0x${toHexString(new Uint8Array(bridgeLockArgs.getOwnerCellTypeHash().raw()))}`;
  return ownerTypeHash === expectOwnerTypeHash;
}

export async function parseBTCBurnTx(tx: Transaction): Promise<RecipientCellData | null> {
  if (tx.outputs.length < 1 || tx.outputs[0].type === null) {
    return null;
  }

  const witness = BurnCTMeta.fromWitness(tx.witnesses[0]);
  if (!witness) {
    return null;
  }

  const amount = tx.outputs.reduce((acc, output, i) => {
    if (
      output.lock.codeHash === ForceBridgeCore.config.btc.btcRecipientLock.codeHash &&
      output.lock.hashType === ForceBridgeCore.config.btc.btcRecipientLock.hashType &&
      output.lock.args === ForceBridgeCore.config.btc.btcRecipientLock.args &&
      output.type &&
      output.type.codeHash === ForceBridgeCore.config.ckb.deps.xudtType.script.codeHash &&
      output.type.hashType === ForceBridgeCore.config.ckb.deps.xudtType.script.hashType
    ) {
      acc = acc.add(number.Uint128LE.unpack(bytes.bytify(tx.outputsData[i]).subarray(0, 16)));
    }
    return acc;
  }, BI.from(0));

  if (amount.lte(0)) {
    return null;
  }

  return new BTCRecipientCellData(amount, witness.recipient, 'btc');
}

export async function parseBurnTx(tx: Transaction): Promise<RecipientCellData | null> {
  if (tx.outputs.length < 1 || tx.outputs[0].type === null) {
    return null;
  }
  const recipientTypescript = nonNullable(tx.outputs[0].type);
  const expectRecipientTypescript = ForceBridgeCore.config.ckb.deps.recipientType.script;
  logger.debug('recipientScript:', recipientTypescript);
  logger.debug('expect:', expectRecipientTypescript);
  if (
    recipientTypescript.codeHash !== expectRecipientTypescript.codeHash ||
    recipientTypescript.hashType !== expectRecipientTypescript.hashType
  ) {
    return null;
  }
  let cellData: RecipientCellData | null;
  try {
    cellData = new EthRecipientCellData(fromHexString(tx.outputsData[0]).buffer);
  } catch (e) {
    logger.warn(`parse recipient data error: ${e.message} ${e.stack}`);
    return null;
  }
  logger.debug('amount: ', cellData.getAmount().toHexString());
  logger.debug('recipient address: ', cellData.getRecipientAddress());
  logger.debug('asset: ', cellData.getAsset());
  logger.debug('chain: ', cellData.getChain());
  const recipientCellBridgeLockCodeHash = cellData.getBridgeLockCodeHash();
  const recipientCellBridgeLockHashType = cellData.getBridgeLockHashType() === 0 ? 'data' : 'type';
  const expectBridgeLockscript = ForceBridgeCore.config.ckb.deps.bridgeLock.script;
  const recipientCellOwnerTypeHash = cellData.getOwnerCellTypeHash();
  const ownerTypeHash = getOwnerTypeHash();
  if (
    recipientCellBridgeLockCodeHash !== expectBridgeLockscript.codeHash ||
    recipientCellBridgeLockHashType !== expectBridgeLockscript.hashType ||
    recipientCellOwnerTypeHash !== ownerTypeHash
  ) {
    return null;
  }
  return cellData;
}

type BurnDbData = {
  cellData: RecipientCellData;
  senderAddress: string;
};
