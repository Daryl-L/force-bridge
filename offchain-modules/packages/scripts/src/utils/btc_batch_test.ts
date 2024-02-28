import { hd, Indexer as CkbIndexer, RPC, Script, helpers, Indexer, commons, BI, Transaction } from '@ckb-lumos/lumos';
import { JSONRPCClient } from 'json-rpc-2.0';

import { prepareCkbAddresses, prepareCkbPrivateKeys } from './eth_batch_test';

export async function generateLockTx() {}

export async function generateBurnTx() {}

export async function lock() {}

export async function burn() {}

export async function btcBatchTest(
  btcPrivateKey: string,
  ckbPrivateKey: string,
  ckbNodeUrl: string,
  ckbIndexerUrl: string,
  forceBridgeUrl: string,
  batchNum = 100,
  btcToken = 'btc',
  lockAmount = '2000000000000000',
  burnAmount = '1000000000000000',
) {
  const rpc = new RPC(ckbNodeUrl);

  const client = new JSONRPCClient((jsonRPCRequest) =>
    fetch(forceBridgeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(jsonRPCRequest),
    }).then((response) => {
      if (response.status === 200) {
        // Use client.receive when you received a JSON-RPC response.
        return response.json().then((jsonRPCResponse) => client.receive(jsonRPCResponse));
      } else if (jsonRPCRequest.id !== undefined) {
        return Promise.reject(new Error(response.statusText));
      }
    }),
  );

  const ckbPrivateKeys = prepareCkbPrivateKeys(batchNum);
  const ckbddresses = await prepareCkbAddresses(rpc, ckbPrivateKeys, ckbPrivateKey, ckbNodeUrl, ckbIndexerUrl);
}
