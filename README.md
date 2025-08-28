# MonoMine 🎮

Daily micro-proof-of-work game on **Monad testnet**, built for the Monad Game Jam.


How to Play

    Sign in with Farcaster
    No wallet? No problem. You can mint your TMF Passport gaslessly through Monad Fantastic using only your Farcaster ID.

        When you click Mint Passport, the TMF relayer will create a wallet for you and mint the Passport without requiring you to manage keys up front.

        This Passport-linked wallet becomes your game identity.

    Start Mining
    Once you have a Passport (either from your Farcaster sign-in or a connected wallet), click Start Mining. Your browser will begin hashing nonces against today’s seed.

    Submit Best Nonce
    With Gasless via TMF enabled, your mined nonce is submitted through the EntryForwarder + RelayManager — so you don’t need to hold any testnet tokens.

    Check Leaderboard & Share
    See your position instantly, and share your score on Farcaster with one click.





Players mine locally (in browser) against a daily seed. 
Submit your best nonce → contract verifies on-chain. 
Leaderboard resets each epoch. 
All participation requires a **TMF Passport**.


## Contracts

- **MonoMine**: `0x49c52AEb95BEA2E22bede837B77C4e482840751e`
- **TMF Passport**: `0x4c180b77d707BfE640dBC00963fB48dfca36420A`
- **TMF EntryForwarder**: `0xb25D7eAba78995880E7d64C4003ab23640246968`
- **TMF RelayManager**: `0x1dcF1289C13F60FE66560C2bE17595e8c7C5fac7`

## Build & Deploy

```bash
# install dependencies
forge install foundry-rs/forge-std --no-git

# build
forge build

# deploy
source .env
forge script script/DeployMonoMine.s.sol:DeployMonoMine \
  --rpc-url $MONAD_RPC --broadcast -vvvv