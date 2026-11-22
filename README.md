# LeashGuard

> An AI agent that can pay your bills, but can’t drain your account—every limit is enforced on‑chain by a post‑quantum signature.

[![Built on QoreChain](https://build.qorechain.io/badge/leashguard.svg)](https://build.qorechain.io/p/leashguard)

## What It Does
LeashGuard is a **post‑quantum AI agent** for treasury management. The agent autonomously pays approved invoices and subscriptions, but its spending power is bounded by an on‑chain `AgentVault` contract. The owner uses their **ML‑DSA‑87 key** to set payees and limits; the agent uses a separate key that can only call `payBill`. Even if the agent’s classical key is stolen, the attacker cannot exceed the rules or pay an unapproved address.

## Architecture
- **AgentVault.sol** – Stores payees, per‑tx limit, daily limit, and owner PQC key hash.
- **AI Agent (Node.js/TS)** – Reads invoices, simulates `payBill`, signs hybridly with QoreSign, broadcasts.
- **Owner Dashboard (React)** – QoreX wallet integration; approve payees; update rules (PQC‑signed).

## Built With
- QoreChain SDK (TypeScript, React)
- QoreSign
- create‑qorechain‑dapp
- QoreX integrations
- Hardhat (contract tests)

## Network Features Used
- Hybrid ML‑DSA‑87 transactions
- Scoped EVM window
- Smart‑account spending rules
- PQC key registration with proof of possession
- Test tokens (fUSD, fETH, fBTC)

## Running Locally
1. Clone the repo.
2. `npm install`
3. Copy `.env.example` to `.env` and add your testnet RPC URL and a funded test account.
4. Deploy `AgentVault.sol` (see `scripts/deploy.ts`).
5. Start the agent: `npm run agent`
6. Start the dashboard: `npm run dev`

## Q‑Day Drill Proof
During the drill, we will show that a stolen classical key cannot:
1. Open or modify the EVM window.
2. Change the vault’s spending rules.
3. Pay an unapproved payee.

## AI Usage
See [AI_USAGE.md](./AI_USAGE.md) for a full description of how AI tools were used during development.

## Licence
MIT - See [LICENSE](./LICENSE).