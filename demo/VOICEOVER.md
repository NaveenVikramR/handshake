# Demo video voiceover (optional)

Read over `demo/handshake-demo.mp4` (2:04). The timings match `demo/SHOTLIST.md`. At a calm pace, about 2.5 words a second, each line fits its scene; if you run long, drop the sentences in brackets. If you record the voice separately, add it with:

`ffmpeg -i demo/handshake-demo.mp4 -i voice.m4a -c:v copy -c:a aac -shortest demo/handshake-demo-voice.mp4`

| Time | Scene                  | Say                                                                                                                                                                             |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Title card             | PayPal's CEO said it on the last earnings call: when agents buy from agents, both sides must prove they're real. Handshake does that today, on PayPal.                          |
| 0:06 | Landing                | This is Handshake. Your AI agent shops; you approve; PayPal moves the money.                                                                                                    |
| 0:11 | Sign up                | Maya signs up with a passkey: Face ID or a fingerprint. There's no password to steal.                                                                                           |
| 0:16 | Ask your agent         | She asks her agent for rice. It finds Corner Grocery and checks the shop's signed offer against a trust registry. [The price comes from that signed offer, never from the LLM.] |
| 0:24 | Approve the exact cart | Her phone shows exactly what she's paying for: the shop, the item, the total, the address. Face ID signs a hash of this exact cart. Change one cent, and the signature breaks.  |
| 0:34 | PayPal                 | The first time, she approves on PayPal. PayPal authorizes and holds the money; nothing is taken yet.                                                                            |
| 0:45 | Payer confirmed        | She confirms her PayPal account with her passkey once, so future purchases skip the redirect.                                                                                   |
| 0:51 | Fulfil and capture     | The shop captures the payment only after fulfilling the order. If delivery fails, the hold is voided.                                                                           |
| 0:59 | Decisions              | Every request shows up live with the gate's decision. [Signatures, cart, passkey, nonce and risk are checked in order.]                                                         |
| 1:06 | Spending permission    | For small things, Maya sets a spending permission, signed with her passkey: limits per order and per month, for this shop.                                                      |
| 1:12 | No approval step       | Now a small purchase goes straight through, with no approval step. The shop still checks every limit itself.                                                                    |
| 1:21 | Captured               | Captured, again only through PayPal.                                                                                                                                            |
| 1:25 | Attack 1               | Now the attacks, live. Someone changes the amount after Maya approved: the cart no longer matches her signature. Blocked.                                                       |
| 1:30 | Attack 2               | A fake merchant agent signs its own offer. Its key isn't in the registry. Blocked.                                                                                              |
| 1:36 | Attack 3               | Replaying an approval that was already used. Every approval works once. Blocked.                                                                                                |
| 1:42 | Assistant              | The shopkeeper assistant, built on PayPal Agent Toolkit, explains what happened. It can propose a refund, but only the merchant can confirm it.                                 |
| 1:52 | Results                | Our attack suite: 96 of 96 cases pass, all 93 attacks blocked, zero unauthorized payments, zero duplicate charges.                                                              |
| 1:58 | Closing                | Handshake. Agents can shop for you, but only you can approve the payment, and every agent proves who it is.                                                                     |
