import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A35",
  title: "DB price raised after the offer: PayPal is asked for the signed total",
  category: "tamper",
  spec: "Merchant price change after offer",
  expect: "OK",
  expectAuthorized: true,
  async run(h) {
    const offer = await h.f.offer();
    h.f.offerStore.products.get("RICE-2KG")!.priceMinor = 5000;
    const out = await h.submit(h.f.passkeyRequest(offer));
    const charged = (h.paypalCalls("create").at(-1)?.args as { totalMinor?: number } | undefined)?.totalMinor;
    return charged === offer.payload.totalMinor ? out : { code: `CHARGED_${charged}`, authorized: true };
  },
});
