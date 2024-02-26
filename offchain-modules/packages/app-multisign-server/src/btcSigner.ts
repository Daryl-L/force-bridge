import { collectSignaturesParams, BTCCollectSignaturesPayload } from '@force-bridge/x/dist/multisig/multisig-mgr';
import { BTCUnlockRecord } from '@force-bridge/x/dist/xchain/btc';
import bitcore from 'bitcore-lib';
import { SigError, SigErrorCode, SigErrorOk } from './error';
import { SigResponse, SigServer } from './sigServer';

export const signBTC = async (params: collectSignaturesParams): Promise<SigResponse> => {
  const { payload, requestAddress, rawData } = params;
  const { unlockRecords } = payload as BTCCollectSignaturesPayload;

  // if (!verifyCollector(params)) {
  //   return SigResponse.fromSigError(SigErrorCode.InvalidCollector);
  // }

  const privateKey = SigServer.getKey('eth', requestAddress ?? '');
  if (privateKey === undefined) {
    return SigResponse.fromSigError(
      SigErrorCode.InvalidParams,
      `cannot found key by address: ${params.requestAddress}`,
    );
  }

  // const btcHandler = ForceBridgeCore.getXChainHandler().btc!;
  // if ((await btcHandler.getTipBlock()).height - btcHandler.getHandledBlock().height >= 10) {
  //   return SigResponse.fromSigError(SigErrorCode.BlockSyncUncompleted);
  // }

  // const signed = await SigServer.signedDb.getSignedByRawData(params.rawData);
  // if (signed) {
  //   return SigResponse.fromData(signed.signature);
  // }

  const signature = sign(rawData, privateKey);

  await verifyUnlockRecord(unlockRecords);

  return SigResponse.fromData(signature);
};

const sign = (rawData: string, privateKey: string): string => {
  const tx = new bitcore.Transaction(rawData);
  tx.sign(privateKey);
  return tx.getSignatures()[0].signature.toDER().toString('hex');
};

const verifyUnlockRecord = async (unlockRecords: BTCUnlockRecord[]): Promise<SigError> => {
  unlockRecords;
  return SigErrorOk;
};
