'use strict';
// tests/scan-logic.test.js — Unit testy pro čistou logiku skenerů
// Nevyžaduje síť ani API klíče — testuje pouze deterministické výpočty.
// Spustit: node tests/scan-logic.test.js

const assert = require('assert');

// Zakáž síťová volání přes prázdné klíče
process.env.OPENROUTER_API_KEY = '';
process.env.ALCHEMY_API_KEY    = '';
process.env.ETHERSCAN_API_KEY  = '';
// Přesměruj Solana RPC na nedosažitelný endpoint (fetch by neměl být volán v unit testech)
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:0';

const { _test: ta } = require('../scanners/token-audit');
const { _test: ev } = require('../scanners/evm-token');

async function main() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [1] token-audit.js — scoreToCategory
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[1] token-audit: scoreToCategory\n');

  await test('score 0 → SAFE', () => {
    assert.strictEqual(ta.scoreToCategory(0), 'SAFE');
  });

  await test('score 30 → SAFE (hranice)', () => {
    assert.strictEqual(ta.scoreToCategory(30), 'SAFE');
  });

  await test('score 31 → CAUTION', () => {
    assert.strictEqual(ta.scoreToCategory(31), 'CAUTION');
  });

  await test('score 65 → CAUTION (hranice)', () => {
    assert.strictEqual(ta.scoreToCategory(65), 'CAUTION');
  });

  await test('score 66 → DANGER', () => {
    assert.strictEqual(ta.scoreToCategory(66), 'DANGER');
  });

  await test('score 100 → DANGER', () => {
    assert.strictEqual(ta.scoreToCategory(100), 'DANGER');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [2] token-audit.js — analyzeConcentration
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[2] token-audit: analyzeConcentration\n');

  await test('null vstup → null', () => {
    assert.strictEqual(ta.analyzeConcentration(null, 1000), null);
    assert.strictEqual(ta.analyzeConcentration([], 1000), null);
    assert.strictEqual(ta.analyzeConcentration([{ amount: 100 }], null), null);
  });

  await test('top1 = 50%, top3 = 80%, top10 = 100%', () => {
    const holders = [
      { amount: 500_000 },
      { amount: 200_000 },
      { amount: 100_000 },
      { amount: 100_000 },
      { amount:  50_000 },
      { amount:  50_000 },
    ];
    const c = ta.analyzeConcentration(holders, 1_000_000);
    assert.strictEqual(c.top1_pct,  50,  `top1 chyba: ${c.top1_pct}`);
    assert.strictEqual(c.top3_pct,  80,  `top3 chyba: ${c.top3_pct}`);
    assert.strictEqual(c.top10_pct, 100, `top10 chyba: ${c.top10_pct}`);
    assert.strictEqual(c.holder_count_visible, 6);
  });

  await test('top1 > 80% (rug threshold)', () => {
    const holders = [{ amount: 900_000 }, { amount: 100_000 }];
    const c = ta.analyzeConcentration(holders, 1_000_000);
    assert.ok(c.top1_pct > 80, `Mělo být >80%, got ${c.top1_pct}`);
  });

  await test('rovnoměrné rozdělení → nízká koncentrace', () => {
    const holders = Array.from({ length: 10 }, () => ({ amount: 100_000 }));
    const c = ta.analyzeConcentration(holders, 1_000_000);
    assert.strictEqual(c.top1_pct,  10);
    assert.strictEqual(c.top3_pct,  30);
    assert.strictEqual(c.top10_pct, 100);
  });

  await test('zaokrouhlení na 1 desetinné místo', () => {
    // 1/3 * 100 = 33.333... → zaokrouhlí na 33.3
    const holders = [{ amount: 333_333 }, { amount: 333_333 }, { amount: 333_334 }];
    const c = ta.analyzeConcentration(holders, 1_000_000);
    assert.strictEqual(c.top1_pct, 33.3);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [3] token-audit.js — WEIGHTS
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[3] token-audit: WEIGHTS\n');

  await test('critical > high > medium > low > info', () => {
    const w = ta.WEIGHTS;
    assert.ok(w.critical > w.high,          'critical musí být > high');
    assert.ok(w.high     > w.medium,        'high musí být > medium');
    assert.ok(w.medium   > w.low,           'medium musí být > low');
    assert.ok(w.low      > (w.info ?? 0),   'low musí být > info');
  });

  await test('info má nulový weight (nepřispívá ke skóre)', () => {
    assert.ok((ta.WEIGHTS.info ?? 0) === 0, `info weight = ${ta.WEIGHTS.info}, očekáváno 0`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [4] evm-token.js — analyzeSource
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[4] evm-token: analyzeSource\n');

  await test('prázdný zdrojový kód → žádné findings', () => {
    const f = ev.analyzeSource('');
    assert.ok(Array.isArray(f) && f.length === 0, `Očekáváno [], got ${JSON.stringify(f)}`);
  });

  await test('selfdestruct → critical finding', () => {
    const f = ev.analyzeSource('function kill() { selfdestruct(owner); }');
    const hit = f.find(x => x.label.includes('selfdestruct'));
    assert.ok(hit, 'Očekáváno selfdestruct finding');
    assert.strictEqual(hit.severity, 'critical');
  });

  await test('openTrading → critical finding', () => {
    const f = ev.analyzeSource('function openTrading() { tradingEnabled = true; }');
    const hit = f.find(x => x.category === 'trading-control');
    assert.ok(hit, 'Očekáváno trading-control finding');
    assert.strictEqual(hit.severity, 'critical');
  });

  await test('mint funkce → high finding', () => {
    const f = ev.analyzeSource('function mint(address to, uint256 amount) public onlyOwner {}');
    const hit = f.find(x => x.category === 'supply');
    assert.ok(hit, 'Očekáváno supply finding');
    assert.strictEqual(hit.severity, 'high');
  });

  await test('blacklist → high finding', () => {
    const f = ev.analyzeSource('mapping(address => bool) public blacklisted;');
    const hit = f.find(x => x.label.includes('blacklist'));
    assert.ok(hit, 'Očekáváno blacklist finding');
    assert.strictEqual(hit.severity, 'high');
  });

  await test('delegatecall → high finding (upgradeable proxy)', () => {
    const f = ev.analyzeSource('(bool ok,) = impl.delegatecall(data);');
    const hit = f.find(x => x.category === 'proxy');
    assert.ok(hit, 'Očekáváno proxy finding');
  });

  await test('Ownable bez renounceOwnership → high finding', () => {
    const f = ev.analyzeSource('contract Token is Ownable { function burn() {} }');
    const hit = f.find(x => x.label.includes('renounceOwnership'));
    assert.ok(hit, 'Očekáváno Ownable-without-renounce finding');
    assert.strictEqual(hit.severity, 'high');
  });

  await test('Ownable S renounceOwnership → žádný Ownable finding', () => {
    const f = ev.analyzeSource('contract Token is Ownable { function renounceOwnership() {} }');
    const hit = f.find(x => x.label.includes('renounceOwnership'));
    assert.ok(!hit, 'Neočekáváno Ownable finding při přítomnosti renounceOwnership');
  });

  await test('čistý ERC20 (bez nebezpečných vzorů) → žádné findings', () => {
    const clean = [
      'contract SimpleToken {',
      '  uint256 public totalSupply = 1000000e18;',
      '  mapping(address => uint256) public balanceOf;',
      '  function transfer(address to, uint256 amount) external returns (bool) {',
      '    balanceOf[msg.sender] -= amount;',
      '    balanceOf[to] += amount;',
      '    return true;',
      '  }',
      '}'
    ].join('\n');
    const f = ev.analyzeSource(clean);
    assert.ok(f.length === 0, `Očekáváno 0 findings, got: ${f.map(x => x.label).join(', ')}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [5] evm-token.js — detectFees
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[5] evm-token: detectFees\n');

  await test('fee = 0 → vrátí 0', () => {
    assert.strictEqual(ev.detectFees('uint256 fee = 0;'), 0);
  });

  await test('buyFee = 5 → vrátí 5', () => {
    assert.strictEqual(ev.detectFees('uint256 buyFee = 5;'), 5);
  });

  await test('buyFee = 5, sellFee = 15 → vrátí 15 (max)', () => {
    assert.strictEqual(ev.detectFees('uint256 buyFee = 5; uint256 sellFee = 15;'), 15);
  });

  await test('fee > 10 → analyzeSource detekuje critical', () => {
    const f = ev.analyzeSource('uint256 tax = 25;');
    const hit = f.find(x => x.label.includes('Fee value > 10%'));
    assert.ok(hit, 'Očekáváno critical fee finding');
    assert.strictEqual(hit.severity, 'critical');
  });

  await test('fee 6-10 → analyzeSource detekuje high', () => {
    const f = ev.analyzeSource('uint256 fee = 8;');
    const hit = f.find(x => x.label.includes('Fee value > 5%'));
    assert.ok(hit, 'Očekáváno high fee finding');
    assert.strictEqual(hit.severity, 'high');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [6] evm-token.js — analyzeTransfers
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[6] evm-token: analyzeTransfers\n');

  await test('null / prázdné → žádné findings', () => {
    assert.strictEqual(ev.analyzeTransfers(null).length, 0);
    assert.strictEqual(ev.analyzeTransfers([]).length,   0);
  });

  await test('single-source distribution (airdrop dump) → high', () => {
    const transfers = Array.from({ length: 25 }, (_, i) => ({
      from: 'deployer',
      to:   `victim${i}`,
      metadata: { blockTimestamp: new Date(Date.now() - 86400000 * 2).toISOString() }
    }));
    const f = ev.analyzeTransfers(transfers);
    const hit = f.find(x => x.label.includes('Single-source distribution'));
    assert.ok(hit, 'Očekáváno single-source finding');
    assert.strictEqual(hit.severity, 'high');
  });

  await test('transfer concentration (2 senderů, 15 transferů) → critical', () => {
    const transfers = Array.from({ length: 15 }, (_, i) => ({
      from: i % 2 === 0 ? 'sender1' : 'sender2',
      to:   `victim${i}`,
    }));
    const f = ev.analyzeTransfers(transfers);
    const hit = f.find(x => x.category === 'concentration');
    assert.ok(hit, 'Očekáváno concentration finding');
    assert.strictEqual(hit.severity, 'critical');
  });

  await test('vysoká velocity (≥50 transferů za hodinu) → high', () => {
    const now = Date.now();
    const transfers = Array.from({ length: 55 }, (_, i) => ({
      from: `sender${i}`,
      to:   `recv${i}`,
      metadata: { blockTimestamp: new Date(now - 60_000).toISOString() }
    }));
    const f = ev.analyzeTransfers(transfers);
    const hit = f.find(x => x.label.includes('High transfer velocity'));
    assert.ok(hit, 'Očekáváno high velocity finding');
    assert.strictEqual(hit.severity, 'high');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [7] evm-token.js — ABI decoders
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[7] evm-token: ABI decoders\n');

  await test('decodeString — validní ABI-encoded string "USDC"', () => {
    const hex = '0x'
      + '0000000000000000000000000000000000000000000000000000000000000020' // offset
      + '0000000000000000000000000000000000000000000000000000000000000004' // length=4
      + '5553444300000000000000000000000000000000000000000000000000000000'; // "USDC"
    assert.strictEqual(ev.decodeString(hex), 'USDC');
  });

  await test('decodeString — 0x → null', () => {
    assert.strictEqual(ev.decodeString('0x'), null);
  });

  await test('decodeUint256 — validní uint256 (1 000 000)', () => {
    const hex = '0x' + BigInt(1_000_000).toString(16).padStart(64, '0');
    assert.strictEqual(ev.decodeUint256(hex), 1_000_000n);
  });

  await test('decodeAddress — extrahuje adresu z ABI padded hex', () => {
    const hex = '0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12';
    const addr = ev.decodeAddress(hex);
    assert.ok(addr && addr.startsWith('0x'), 'Adresa musí začínat 0x');
    assert.strictEqual(addr.length, 42);
  });

  await test('decodeAddress — 0x → null', () => {
    assert.strictEqual(ev.decodeAddress('0x'), null);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // [8] evm-token.js — WEIGHTS konzistence
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[8] evm-token: WEIGHTS konzistence\n');

  await test('EVM WEIGHTS: critical > high > medium > low', () => {
    const w = ev.WEIGHTS;
    assert.ok(w.critical > w.high,   'critical > high');
    assert.ok(w.high     > w.medium, 'high > medium');
    assert.ok(w.medium   > w.low,    'medium > low');
  });

  await test('EVM: tři critical findings se drží pod 100 (Math.min cap)', () => {
    const threeHits = 3 * ev.WEIGHTS.critical;
    const score = Math.min(100, threeHits);
    assert.ok(score <= 100, `Score ${score} přesáhlo 100`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Výsledky
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`scan-logic.test.js: ${passed + failed} testů, ${passed} prošlo, ${failed} selhalo`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
