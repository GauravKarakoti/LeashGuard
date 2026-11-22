# AI Usage in LeashGuard

We used AI coding assistants throughout the fest, but every AI‑generated artefact was reviewed, tested, and adapted by a human.

## How We Used AI
- **Code generation**: The initial Solidity `AgentVault` skeleton and the Node.js agent loop were drafted with an AI assistant (Claude/Cursor). We then rewrote the access‑control logic manually to ensure the PQC key‑check was correct.
- **Debugging**: When the hybrid‑signing flow failed, we used an AI assistant to interpret the QoreChain error messages and suggest fixes.
- **Documentation**: The README and this file were drafted with AI, but the technical details were verified against the actual code and the QoreChain documentation.
- **Testing**: AI generated Foundry test stubs; we filled in the assertions and edge cases ourselves.

## What Was Human‑Made
- The **security model** (two‑key separation, rule‑change authorization) was designed by the team.
- All final code was **reviewed line‑by‑line** and tested on the Diana testnet.
- The **Q‑Day Drill plan** and the threat model were written without AI assistance.

## Lessons Learned
AI significantly accelerated boilerplate and debugging, but the **post‑quantum specifics** (ML‑DSA‑87 signature encoding, EVM window scoping) required careful human verification against the official QoreChain specs.