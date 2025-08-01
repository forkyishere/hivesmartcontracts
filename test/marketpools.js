/* eslint-disable */
const assert = require('assert');
const { createVerify } = require('crypto');
const { MongoClient } = require('mongodb');
const { Base64 } = require('js-base64');
const BigNumber = require('bignumber.js');
const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens_minify.js');
const nftContractPayload = setupContractPayload('nft', './contracts/nft_minify.js');
const miningPayload = setupContractPayload('mining', './contracts/mining_minify.js');
const marketPayload = setupContractPayload('market', './contracts/market_minify.js');
const contractPayload = setupContractPayload('marketpools', './contracts/marketpools_minify.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertContractBalance(account, symbol, balance) {
  const res = await fixture.database.findOne({
    contract: 'tokens',
    table: 'contractsBalances',
    query: { account, symbol }
  });

  if (!balance) {
    assert(!res, `Balance found for ${account}, ${symbol}, expected none.`);
    return;
  }
  assert.ok(res, `No balance for ${account}, ${symbol}`);
  assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
}

async function assertShareConsistency(tokenPair) {
  const pool = await fixture.database.findOne({
    contract: 'marketpools',
    table: 'pools',
    query: { tokenPair }
  });
  const lp = await fixture.database.find({
    contract: 'marketpools',
    table: 'liquidityPositions',
    query: { tokenPair }
  });
  const lpShares = lp.reduce((acc, val) => BigNumber(acc).plus(val.shares), 0);
  assert.equal(lpShares, pool.totalShares, 'total shares in liquidity positions doesn\'t equal pool.totalShares');
}

async function assertPoolStats(tokenPair, stats) {
  const res = await fixture.database.findOne({
    contract: 'marketpools',
    table: 'pools',
    query: { tokenPair }
  });
  assert.equal(res.baseQuantity, stats.baseQuantity, `baseQuantity has ${res.baseQuantity}, expected ${stats.baseQuantity}`);
  assert.equal(res.quoteQuantity, stats.quoteQuantity, `quoteQuantity has ${res.quoteQuantity}, expected ${stats.quoteQuantity}`);
  assert.equal(res.baseVolume, stats.baseVolume, `baseVolume has ${res.baseVolume}, expected ${stats.baseVolume}`);
  assert.equal(res.quoteVolume, stats.quoteVolume, `quoteVolume has ${res.quoteVolume}, expected ${stats.quoteVolume}`);
  assert.equal(res.basePrice, stats.basePrice, `basePrice has ${res.basePrice}, expected ${stats.basePrice}`);
  assert.equal(res.quotePrice, stats.quotePrice, `quotePrice has ${res.quotePrice}, expected ${stats.quotePrice}`);
}

async function assertTokenBalance(id, symbol, balance) {
  let hasBalance = false;
  let dist = await fixture.database.findOne({
    contract: 'marketpools',
    table: 'batches',
    query: {
      _id: id
    }
  });
  if (dist.tokenBalances) {
    for (let i = 0; i <= dist.tokenBalances.length; i += 1) {
      if (dist.tokenBalances[i].symbol === symbol) {
        assert.equal(dist.tokenBalances[i].quantity, balance, `contract ${id} has ${symbol} balance ${dist.tokenBalances[i].quantity}, expected ${balance}`);
        hasBalance = true;
        break;
      }
    }
    if (balance === undefined) {
      assert(!hasBalance, `Balance found for contract ${id}, ${symbol}, expected none.`);
      return;
    }
  }
  assert.ok(hasBalance, `No balance for contract ${id}, ${symbol}`);
}

async function assertAllErrorInLastBlock() {
  const transactions = (await fixture.database.getLatestBlockInfo()).transactions;
  for (let i = 0; i < transactions.length; i++) {
    const logs = JSON.parse(transactions[i].logs);
    assert(logs.errors, `Tx #${i} had unexpected success ${logs.errors}`);
  }
}

async function getLastPoolId() {
  let blk = await fixture.database.getLatestBlockInfo();
  let eventLog = JSON.parse(blk.transactions[8].logs);
  let createEvent = eventLog.events.find(x => x.event === 'createPool');
  return createEvent.data.id;
}

// distribution test suite
describe('marketpools tests', function () {
  this.timeout(20000);

  before(async () => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
  });
  
  after(async () => {
      await client.close();
  });

  beforeEach(async () => {
      db = await client.db(conf.databaseName);
  });

  afterEach(async () => {
        fixture.tearDown();
        await db.dropDatabase()
  });

  it('should not create invalid pool', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLDSLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "TKN:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:TKN", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "SLV:GLD", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[8], 'you must use a transaction signed with your active key');
      assertError(txs[9], 'invalid tokenPair format');
      assertError(txs[10], 'tokenPair cannot be the same token');
      assertError(txs[11], 'baseSymbol does not exist');
      assertError(txs[12], 'quoteSymbol does not exist');
      assertError(txs[14], 'a pool already exists for this tokenPair');
      assertError(txs[15], 'a pool already exists for this tokenPair');
      
      res = await fixture.database.find({
        contract: 'marketpools',
        table: 'pools',
        query: { tokenPair: { '$ne': 'GLD:SLV' } }
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid pool created');
  });

  it('should create valid pool', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      // console.log(blk);
      await tableAsserts.assertNoErrorInLastBlock();
      const id = await getLastPoolId();
      let res = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: {
          _id: id
        }
      });
      assert.ok(res, 'newly created pool not found');
      await assertShareConsistency("GLD:SLV");
  });

  it('should allow owner to update params', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'marketpools', 'updateParams', '{ "poolCreationFee": "2000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'params',
        query: {},
      });
      assert.ok(res.poolCreationFee === '2000', 'fee has not changed');
  });

  it('should not add liquidity to invalid pairs/pools', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "x", "quoteQuantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "500", "quoteQuantity": "x", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:TKN", "baseQuantity": "500", "quoteQuantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "500", "quoteQuantity": "500", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "100000", "quoteQuantity": "1600000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000.1234567899", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "halfwhale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'halfwhale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "100", "maxPriceImpact": "0", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "100", "quoteQuantity": "1", "isSignedWithActiveKey": true }'));      

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[9], 'you must use a transaction signed with your active key');
      assertError(txs[10], 'invalid baseQuantity');
      assertError(txs[11], 'invalid quoteQuantity');
      assertError(txs[12], 'quoteSymbol does not exist');
      assertError(txs[18], 'exceeded max price impact for adding liquidity');
      assertError(txs[19], 'insufficient token balance');
      assertError(txs[20], 'baseQuantity precision mismatch');
      assertError(txs[22], 'insufficient token balance');
      assertError(txs[23], 'maxPriceImpact must be greater than 0');
      assertError(txs[24], 'exceeded max price impact for adding liquidity');
      
      res = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "whale" },
      });
  
      assert.ok(!res, 'uncaught errors, invalid LP created');
  });

  it('should not add liquidity beyond oracle deviation', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "investor", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "GLD", "quantity": "100", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "SLV", "quantity": "100", "price": "0.625", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "GLD", "quantity": "1", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "SLV", "quantity": "1", "price": "0.625","isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "10", "quoteQuantity": "150", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "GLD", "quantity": "100", "price": "0.80000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "SLV", "quantity": "100", "price": "0.002044", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "GLD", "quantity": "1", "price": "0.80000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "SLV", "quantity": "1", "price": "0.002044","isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "3913.89", "quoteQuantity": "10", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[18], 'exceeded max deviation from order book');
      assertError(txs[23], 'exceeded max deviation from order book');
      
      res = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "whale" },
      });
  
      assert.ok(!res, 'uncaught errors, invalid LP created');
  });

  it('should allow user determined oracle deviation', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "investor", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "GLD", "quantity": "100", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "SLV", "quantity": "100", "price": "0.625", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "GLD", "quantity": "1", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "SLV", "quantity": "1", "price": "0.625","isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "10", "quoteQuantity": "150", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "GLD", "quantity": "100", "price": "0.80000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "SLV", "quantity": "100", "price": "0.002044", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "GLD", "quantity": "1", "price": "0.80000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "SLV", "quantity": "1", "price": "0.002044","isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "11", "quoteQuantity": "10", "maxDeviation": "0", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[18], 'exceeded max deviation from order book');
      
      res = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "investor" },
      });
  
      assert.ok(res, 'expected LP to be created for investor');
  });  

  it('should add liquidity and update positions', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "investor", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "GLD", "quantity": "100", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "SLV", "quantity": "100", "price": "0.625", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "GLD", "quantity": "1", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "SLV", "quantity": "1", "price": "0.625","isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1.234", "tradeType": "exactOutput", "isSignedWithActiveKey": true}'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "0.03987654", "quoteQuantity": "0.62476567", "maxPriceImpact": "10", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      let lpos = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "investor" },
      });
      let lpool = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: { tokenPair: "GLD:SLV" },
      });
      await assertShareConsistency("GLD:SLV");
      assert.ok(lpos, 'newly created LP not found');
      assert.ok(lpos.shares === '4004.15620342579566159662', `LP shares not as expected - ${lpos.shares}`);
      assert.ok(lpool.totalShares === '4008.15620342579566159662', `Pool total shares not as expected - ${lpool.totalShares}`);
      assert.ok(lpool.basePrice === '15.99753393', `pool price not as expected - ${lpool.basePrice}`);
      assert.ok(lpool.baseQuantity === '1002.11637812', `pool baseQuantity not as expected - ${lpool.baseQuantity}`);
      assert.ok(lpool.quoteQuantity === '16031.39076567', `pool quoteQuantity not as expected - ${lpool.quoteQuantity}`);
  });

  it('should add liquidity and update positions with mixed precision', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "investor", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "GLD", "quantity": "100", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'market', 'sell', '{ "symbol": "SLV", "quantity": "100", "price": "0.625", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "GLD", "quantity": "1", "price": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'market', 'buy', '{ "symbol": "SLV", "quantity": "1", "price": "0.625","isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1.234", "tradeType": "exactOutput", "maxPriceImpact": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1.02555", "quoteQuantity": "15.997", "maxPriceImpact": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16.1", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      let lpos = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "investor" },
      });
      let lpool = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: { tokenPair: "GLD:SLV" },
      });
      await assertShareConsistency("GLD:SLV");
  });  

  it('should not remove liquidity from invalid pairs/pools', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "sharesOut": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "sharesOut": "x", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:TKN", "sharesOut": "100", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "sharesOut": "100", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[13], 'no existing liquidity position');
      assertError(txs[15], 'you must use a transaction signed with your active key');
      assertError(txs[16], 'invalid sharesOut, must be > 0 <= 100');
      assertError(txs[18], 'no existing liquidity position');
      
      let lpos = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "whale" },
      });

      let lpos2 = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: { tokenPair: "GLD:SLV", account: "investor" },
      });      
  
      assert.ok(!lpos, 'uncaught errors, invalid LP created');
      assert.ok(lpos2.shares === '4000', 'uncaught errors, invalid LP removed');
  });  

  it('should remove liquidity and update positions', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "20000", "to": "whale.two", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "whale.two", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "trader", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "trader", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale.two', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'trader', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactOutput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'trader', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1", "tradeType": "exactOutput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'trader', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactInput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'trader', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1", "tradeType": "exactInput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "sharesOut": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "sharesOut": "100", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      await tableAsserts.assertNoErrorInLastBlock();
      let lpos = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: {
          tokenPair: "GLD:SLV",
          account: "investor"
        }
      });
      let lpos2 = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'liquidityPositions',
        query: {
          tokenPair: "GLD:SLV",
          account: "whale"
        }
      });      
      let lpool = await fixture.database.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: {
          _id: 1
        }
      });
      await assertShareConsistency("GLD:SLV");
      assert.ok(lpos, 'active LP not found');
      assert.ok(!lpos2, 'supposed to be deleted LP found');
      assert.ok(lpos.shares === '2000', `LP shares not as expected - ${lpos.shares}`);
      assert.ok(lpool.basePrice === '16.00003852', `pool price not as expected - ${lpool.basePrice}`);
      assert.ok(lpool.baseQuantity === '1500.00018769', `pool baseQuantity not as expected - ${lpool.baseQuantity}`);
      assert.ok(lpool.quoteQuantity === '24000.06079337', `pool quoteQuantity not as expected - ${lpool.quoteQuantity}`);
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'GLD', balance: '500.00006255'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'GLD', balance: '1000.00000012'});
  });

  it('should not swap tokens with errors', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "100", "quoteQuantity": "1000", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1010", "tradeType": "exactOutput", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1000", "tradeType": "exactOutput", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "2000", "tradeType": "exactInput", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "2000", "tradeType": "exactInput", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLDSLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactInput", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactInput", "minAmountOut": "0", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactInput", "minAmountOut": "1", "maxAmountIn": "1", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1", "tradeType": "exactInput", "minAmountOut": "1", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactOutput", "maxAmountIn": "10", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "2.1234567899", "tradeType": "exactOutput", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "2", "tradeType": "x", "isSignedWithActiveKey": true}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[0], 'insufficient liquidity');
      assertError(txs[1], 'insufficient liquidity');
      assertError(txs[2], 'insufficient input balance');
      assertError(txs[3], 'insufficient input balance');
      assertError(txs[4], 'invalid tokenPair format');
      assertError(txs[5], 'insufficient minAmountOut');
      assertError(txs[6], 'specify minAmountOut or maxAmountIn but not both');
      assertError(txs[7], 'exceeded max slippage for swap');
      assertError(txs[8], 'exceeded max slippage for swap');
      assertError(txs[9], 'symbolOut precision mismatch');
      assertError(txs[10], 'invalid tradeType');
  });

  it('should swap tokens in either direction', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 5, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "10000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "10000", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactOutput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1", "tradeType": "exactOutput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "1", "tradeType": "exactInput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenAmount": "1", "tradeType": "exactInput", "maxSlippage": "0.5", "isSignedWithActiveKey": true}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      // verify swap execution
      await tableAsserts.assertUserBalances({ account: 'buyer', symbol: 'SLV', balance: '999.94794080'});
      await tableAsserts.assertUserBalances({ account: 'buyer', symbol: 'GLD', balance: '999.99969'});
      await assertContractBalance('marketpools', 'SLV', 10000.05205920);
      await assertContractBalance('marketpools', 'GLD', 1000.00031);

      // verify pool stats execution
      await assertPoolStats('GLD:SLV', {
        baseQuantity: 1000.00030048,
        quoteQuantity: 10000.05205918,
        baseVolume: 2.19981945,
        quoteVolume: 22.01813631,
        basePrice: 10.00004905,
        quotePrice: 0.09999950,        
      });
      await assertShareConsistency("GLD:SLV");
  });

  it('should not create invalid reward pools', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));            
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "SLVGLD", "lotteryWinners": 20, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 40, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 800, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'mining', 'createPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "externalMiners": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      let rewardPoolId = 'GLD:EXT-GLDSLV';

      assertError(txs[14], 'pool must have liquidity positions');
      assertError(txs[18], 'invalid tokenPair format');
      assertError(txs[19], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[20], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[21], 'minedToken does not exist');
      assertError(txs[22], 'must be called from a contract');
      assertError(txs[24], 'pool already exists');
  });  

  it('should create and run reward pools', async () => {
      await fixture.setUp();

      // setup
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      // let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);      
      await tableAsserts.assertNoErrorInLastBlock();

      // jump 1 hour
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // test
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'GLD:EXT-GLDSLV');
      assert.equal(lotteryEvent.data.winners.length, 20);

      let token = await fixture.database.findOne({
        contract: 'tokens',
        table: 'tokens',
        query: {
          symbol: 'GLD'
        }
      });
      assert.equal(token.supply, '3001.00000000');

      // shut down pool
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'setRewardPoolActive', '{ "tokenPair": "GLD:SLV", "minedToken": "GLD", "active": false, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
  });

  it('should update and run reward pools', async () => {
      await fixture.setUp();

      // setup
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'updateRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 10, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      // let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      // jump 1 hour
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // test
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'GLD:EXT-GLDSLV');
      assert.equal(lotteryEvent.data.winners.length, 10);

      let token = await fixture.database.findOne({
        contract: 'tokens',
        table: 'tokens',
        query: {
          symbol: 'GLD'
        }
      });
      assert.equal(token.supply, '3001.00000000');

      // shut down pool
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'setRewardPoolActive', '{ "tokenPair": "GLD:SLV", "minedToken": "GLD", "active": false, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
  });  

  it('should create and run query-limited reward pools', async () => {
      await fixture.setUp();

      // setup
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createRewardPool', '{ "tokenPair": "GLD:SLV", "lotteryWinners": 20, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "GLD", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      // let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);      
      await tableAsserts.assertNoErrorInLastBlock();

      // jump 1 hour
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // test
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'GLD:EXT-GLDSLV');
      assert.equal(lotteryEvent.data.winners.length, 20);

      let token = await fixture.database.findOne({
        contract: 'tokens',
        table: 'tokens',
        query: {
          symbol: 'GLD'
        }
      });
      assert.equal(token.supply, '3001.00000000');

      // shut down pool
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'setRewardPoolActive', '{ "tokenPair": "GLD:SLV", "minedToken": "GLD", "active": false, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
  });    

  it('handles differing token precision', async () => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(marketPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 1
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload))); // update 2      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "10000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "0.001", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "1016.418", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "0.000499", "tradeType": "exactInput", "maxSlippage": "1", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buyer', 'marketpools', 'swapTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenAmount": "0.00129999", "tradeType": "exactOutput", "maxSlippage": "1", "isSignedWithActiveKey": true}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);

      // verify swap execution
      await tableAsserts.assertUserBalances({ account: 'buyer', symbol: 'GLD', balance: '1000.00000000'});
      await tableAsserts.assertUserBalances({ account: 'buyer', symbol: 'SLV', balance: '0.001'});
      await assertContractBalance('marketpools', 'GLD', 1000);
      await assertContractBalance('marketpools', 'SLV', 1016.418);

      // verify pool stats execution
      await assertPoolStats('GLD:SLV', {
        baseQuantity: 1000,
        quoteQuantity: 1016.418,
        baseVolume: 0,
        quoteVolume: 0,
        basePrice: 1.01641800,
        quotePrice: 0.98384719,        
      });
      await assertShareConsistency("GLD:SLV");
  });
  // END TESTS
});
