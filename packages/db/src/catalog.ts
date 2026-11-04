// The demo merchant and catalog: `pnpm db:seed` creates them, the demo reset (M10) restocks to them.
export const DEMO_MERCHANT = { id: "mer_corner", name: "Corner Grocery" };

export const DEMO_PRODUCTS = [
  { sku: "RICE-2KG", name: "Basmati rice 2 kg", category: "grocery", priceMinor: 499, stock: 50 },
  { sku: "ATTA-5KG", name: "Whole wheat atta 5 kg", category: "grocery", priceMinor: 899, stock: 30 },
  { sku: "DAL-1KG", name: "Toor dal 1 kg", category: "grocery", priceMinor: 349, stock: 40 },
  { sku: "MILK-1L", name: "Milk 1 L", category: "dairy", priceMinor: 129, stock: 60 },
  { sku: "DET-1L", name: "Liquid detergent 1 L", category: "household", priceMinor: 650, stock: 25 },
  { sku: "SOAP-4PK", name: "Bath soap, 4 pack", category: "household", priceMinor: 399, stock: 25 },
];
