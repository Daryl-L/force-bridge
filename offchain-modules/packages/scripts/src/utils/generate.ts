import {
  genRandomHex,
  privateKeyToCkbAddress,
  privateKeyToCkbPubkeyHash,
  privateKeyToEthAddress,
} from '@force-bridge/x/dist/utils';
import bitcore from 'bitcore-lib';

export interface VerifierConfig {
  privkey: string;
  ckbAddress: string;
  ckbPubkeyHash: string;
  ethAddress: string;
  btcPublicKey: string;
}

export function genRandomVerifierConfig(): VerifierConfig {
  const privkey = genRandomHex(64);
  return {
    privkey,
    ckbAddress: privateKeyToCkbAddress(privkey),
    ckbPubkeyHash: privateKeyToCkbPubkeyHash(privkey),
    ethAddress: privateKeyToEthAddress(privkey),
    btcPublicKey: new bitcore.PrivateKey(privkey.substring(2)).toPublicKey().toString('hex'),
  };
}
