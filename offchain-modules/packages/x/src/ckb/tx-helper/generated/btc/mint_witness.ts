import { WitnessArgs } from '@ckb-lumos/base/lib/blockchain';
import { number, bytes } from '@ckb-lumos/codec';
import { BI } from '@ckb-lumos/lumos';

export class BTCMintWitness {
  constructor(public lockIds: string[]) {}

  static fromWitness(witness: string): BTCMintWitness | undefined {
    let { inputType } = WitnessArgs.unpack(witness);
    if (!inputType) {
      return undefined;
    }

    const lockHashes: string[] = [];
    const lockHashBytes = bytes.bytify(inputType.substring(2));
    let i = 0;
    while (i < lockHashBytes.length) {
      const length = number.Uint128LE.unpack(lockHashBytes.slice(i, i + 16));
      lockHashes.push(`0x${bytes.hexify(lockHashBytes.slice(i + 16, i + 16 + length.toNumber()))}`);
    }

    return new BTCMintWitness(lockHashes);
  }

  serializeWitness(): string {
    const lockHashes = this.lockIds.map((lockHash) => lockHash.substring(2));
    const lockHashLengths = lockHashes.map((lockHash) => bytes.hexify(number.Uint128LE.pack(BI.from(lockHash.length))));

    return bytes.hexify(
      WitnessArgs.pack({
        inputType: `0x${lockHashes.map((key, lockHash) => `${lockHashLengths[key]}${lockHash}`).join('')}`,
      }),
    );
  }
}
