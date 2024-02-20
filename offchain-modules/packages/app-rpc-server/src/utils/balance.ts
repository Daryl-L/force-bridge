import { helpers } from '@ckb-lumos/lumos';
import { IndexerCollector } from '@force-bridge/x/dist/ckb/tx-helper/collector';
import { ForceBridgeCore } from '@force-bridge/x/dist/core';
import { logger } from '@force-bridge/x/dist/utils/logger';
import { IBalance } from '@force-bridge/x/dist/xchain/btc';
import bitcore from 'bitcore-lib';
import { RPCClient } from 'rpc-bitcoin';
import { AssetType } from '../types';

export const nervosBalance = async (address: string, token: string): Promise<AssetType> => {
  const userScript = helpers.parseAddress(address);
  const sudtType = {
    codeHash: ForceBridgeCore.config.ckb.deps.sudtType.script.codeHash,
    hashType: ForceBridgeCore.config.ckb.deps.sudtType.script.hashType,
    args: token,
  };
  const collector = new IndexerCollector(ForceBridgeCore.ckbIndexer);
  const sudt_amount = await collector.getSUDTBalance(sudtType, userScript);
  const amount = sudt_amount.toString();

  return {
    network: 'Nervos',
    ident: token,
    amount,
  };
};

export const btcBalance = async (address: string): Promise<AssetType> => {
  const rpcClient = new RPCClient(ForceBridgeCore.config.btc.clientParams);
  const liveUtxos: IBalance = await rpcClient.scantxoutset({
    action: 'start',
    scanobjects: [`addr(${address})`],
  });
  logger.debug(`BalanceOf address:${address} on BTC is ${liveUtxos.total_amount} btc`);
  const balance = bitcore.Unit.fromBTC(liveUtxos.total_amount).toSatoshis();
  return {
    network: 'Bitcoin',
    ident: 'btc',
    amount: balance as string,
  };
};
