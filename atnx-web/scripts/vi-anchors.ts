// The eyeballed VI anchors agreed with the user on 2026-09-26, shared by
// the calibration and comparison scripts. Values are the midpoints of the
// ranges given; MrBeast and Logan Paul carry the data-side reading the
// user accepted (780 and 480 instead of 675).
export const ANCHORS: Record<string, number> = {
  Google: 900,
  'Donald Trump': 875,
  'Elon Musk': 850,
  Meta: 800,
  Anthropic: 800,
  Bitcoin: 800,
  MrBeast: 780,
  'Logan Paul': 480,
  'DLSS 5': 500,
  'Forrest Jones': 275,
  'Lessons in Meme Culture': 275,
  CaptainSparklez: 275,
  'Toyota AE86': 175,
  'Big Chungus': 175,
  'Ella Freya': 100,
  ATNX: 0,
};

// Contradicted by the readings under any weighting: reported, not fitted.
export const REPORTED: Record<string, number> = { 'Skibidi Toilet': 175, Clavicular: 275, Trollface: 275, 'Hacker News': 500 };
