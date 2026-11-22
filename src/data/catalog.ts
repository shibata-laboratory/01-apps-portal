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
  // 例：
  // {
  //   id: 'timer',
  //   type: 'tool',
  //   title: 'タイマー',
  //   description: '授業や実験で使えるシンプルなタイマー',
  //   url: '/tools/timer/',
  //   requiresRegistration: false,
  //   dataCollection: 'none',
  // },
];
