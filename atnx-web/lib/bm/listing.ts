// A bounded market joined with the atnx market it sits on, as
// /api/bm/markets and the portfolio page serve it.
export interface BmMarketListing {
  id: string;
  atnxMarketId: string;
  name: string;
  thumbnailUrl: string | null;
  currentVi: number;
  chain: string;
  chainLabel: string;
  contractAddress: string;
  onchainMarketId: string | null;
  state: string;
  startVi: number;
  lower: number;
  upper: number;
  resolvedSide: string | null;
  resolvedVi: number | null;
  createdAt: string;
}
