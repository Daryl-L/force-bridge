import { BI } from '@ckb-lumos/lumos';
import { ChainType } from '../../../model/asset';
import { RecipientCellData } from '../recipient_cell';

export class BTCRecipientCellData extends RecipientCellData {
  constructor(private _amount: BI, private _recipientAddress: string, private _asset: string) {
    super();
  }

  getRecipientAddress = () => this._recipientAddress;

  getChain = () => ChainType.BTC;

  getAsset = () => this._asset;

  getBridgeLockCodeHash = () => '';

  getBridgeLockHashType = () => 0;

  getOwnerCellTypeHash = () => '';

  getAmount = () => this._amount;
}
