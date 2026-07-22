const axios = require('axios');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // force ipv4 to see if dns is the issue

const jupApiKey = 'jup_f3bc7a0bdec8f283c5ccaa5a1ff2176672a6c0b67fa1f572d1a8111f472c9712';
const headers = { 'x-api-key': jupApiKey };

async function testLatency(url, label) {
    const start = Date.now();
    try {
        await axios.get(url, { headers, timeout: 5000 });
        console.log(`${label}: ${Date.now() - start}ms`);
    } catch(e) {
        console.log(`${label}: ERROR ${e.message}`);
    }
}

async function run() {
    console.log('Testing Latencies...');
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
    
    await testLatency(`https://api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${WIF}&amount=10000000&slippageBps=50&maxAccounts=28`, 'api.jup.ag (com maxAccounts)');
    await testLatency(`https://api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${WIF}&amount=10000000&slippageBps=50`, 'api.jup.ag (sem maxAccounts)');
    
    await testLatency(`https://quote-api.jup.ag/v6/quote?inputMint=${USDC}&outputMint=${WIF}&amount=10000000&slippageBps=50&maxAccounts=28`, 'quote-api.jup.ag/v6 (com maxAccounts)');
    await testLatency(`https://quote-api.jup.ag/v6/quote?inputMint=${USDC}&outputMint=${WIF}&amount=10000000&slippageBps=50`, 'quote-api.jup.ag/v6 (sem maxAccounts)');
}

run();
