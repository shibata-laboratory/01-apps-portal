// ポータルの静的カタログ（規格 v0.1 第4.5章）。
// ツールとゲームはここで管理する。実験は Firestore の experiments
// コレクションから読み込むため、ここには含めない。

export type CatalogItem = {
  id: string;
  type: 'tool' | 'game';
  title: string;
  description: string;
  url: string;
  requiresRegistration: boolean;
  dataCollection: 'none' | 'usage' | 'research';
};

export const catalog: CatalogItem[] = [
  {
    id: 'timer',
    type: 'tool',
    title: 'プレゼンタイマー',
    description: '発表時間とベル（1〜3回）を設定できる発表用タイマー',
    url: '/tools/timer/',
    requiresRegistration: false,
    dataCollection: 'none',
  },
];
