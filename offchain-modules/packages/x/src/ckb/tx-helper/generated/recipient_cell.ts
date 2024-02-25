import { BI } from '@ckb-lumos/lumos';
import { ChainType } from '../../model/asset';

export abstract class RecipientCellData {
  abstract getRecipientAddress(): string;

  abstract getChain(): ChainType;

  abstract getAsset(): string;

  abstract getBridgeLockCodeHash(): string;

  abstract getBridgeLockHashType(): number;

  abstract getOwnerCellTypeHash(): string;

  abstract getAmount(): BI;
}
