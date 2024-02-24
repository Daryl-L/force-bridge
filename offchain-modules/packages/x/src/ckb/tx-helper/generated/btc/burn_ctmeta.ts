import { WitnessArgs } from '@ckb-lumos/base/lib/blockchain';
import { BI } from '@ckb-lumos/lumos';
import { number, bytes } from '@ckb-lumos/codec';

export class BurnCTMeta {
  recipient: string;

  static fromWitness(witness: string): BurnCTMeta | undefined {
    let { lock } = WitnessArgs.unpack(witness);
    if (!lock) {
      return undefined;
    }

    const recipientLength = number.Uint128LE.unpack(bytes.bytify(lock.substring(2, 34)));
    const recipient = new TextDecoder().decode(bytes.bytify(lock.substring(34, recipientLength.add(34).toNumber())));

    return new BurnCTMeta(recipient);
  }

  constructor(recipient: string) {
    this.recipient = recipient;
  }

  serializeWitness(): string {
    const recipient = bytes.hexify(new TextEncoder().encode(this.recipient));
    const recipientLength = bytes.hexify(number.Uint128LE.pack(BI.from(recipient.length)));

    return bytes.hexify(
      WitnessArgs.pack({
        lock: `${recipientLength}${recipient.substring(2, recipient.length)}`,
      }),
    );
  }
}
