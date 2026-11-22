// @ts-check
import { defineConfig } from 'astro/config';

// ポータルは apps.shibata-lab.jp のドメイン直下で配信する静的サイト。
// 資産パスは www と同じくルート前提で扱い、base は指定しない。
export default defineConfig({
  site: 'https://apps.shibata-lab.jp',
});
