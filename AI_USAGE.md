# AI Usage in LeashGuard

We used AI coding assistants for scaffolding, debugging, and documentation. Every AI‑generated artefact was reviewed and tested by a human.

## How We Used AI
- **Code generation**: Initial Solidity skeleton and agent loop drafted with AI; access‑control logic rewritten manually.
- **Debugging**: AI interpreted QoreChain error messages during hybrid‑signing failures.
- **Documentation**: README and this file drafted with AI, verified against actual code.
- **Testing**: AI generated Foundry test stubs; edge cases written by the team.

## What Was Human‑Made
- Security model (two‑key separation, rule‑change authorization).
- Q‑Day Drill threat model.
- All final code reviewed line‑by‑line and tested on Diana.

## Lessons Learned
AI significantly accelerated boilerplate and debugging, but the **post‑quantum specifics** (ML‑DSA‑87 signature encoding, EVM window scoping) required careful human verification against the official QoreChain specs.