# LeashGuard

> An AI agent that can pay your bills, but can’t drain your account—every limit is enforced on‑chain by a post‑quantum signature.

## What It Does
LeashGuard is a **post‑quantum AI agent** for treasury management. The agent autonomously pays approved invoices and subscriptions, but its spending power is bounded by an on‑chain `AgentVault` contract. The owner uses their **ML‑DSA‑87 key** to set payees and limits; the agent uses a separate key that can only call `payBill`. Even if the agent’s classical key is stolen, the attacker cannot exceed the rules or pay an unapproved address.

## Architecture
- **AgentVault.sol** – Solidity contract that stores approved payees, per‑tx limit, daily limit, and the owner’s PQC key hash.
- **Agent (Node.js/TypeScript)** – Reads pending bills, simulates `payBill`, and broadcasts hybrid‑signed transactions using **QoreSign**.
- **Owner Dashboard (React)** – Connects to QoreX, lets the owner update rules (each update requires an ML‑DSA‑87 signature) and view the agent’s activity.

## Built With
- **QoreChain SDK** (TypeScript, React)
- **QoreSign** (TypeScript)
- **create‑qorechain‑dapp**
- **QoreX integrations**
- **Foundry** (for contract tests)

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
During the Q‑Day Drill (18 Nov 2026), we will:
- Register a fresh testnet account as the drill account.
- Make a `payBill` transaction that is hybrid‑signed.
- Demonstrate that an attacker holding only the classical ECDSA key **cannot** change the vault’s rules or pay an unapproved payee.

## AI Usage
See [AI_USAGE.md](./AI_USAGE.md) for a full description of how AI tools were used during development.

## Licence
MIT (or Apache‑2.0). See [LICENSE](./LICENSE).