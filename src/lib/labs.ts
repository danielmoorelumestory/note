export type Lab = {
  slug: string;
  title: string;
  summary: string;
};

export const labs: Lab[] = [
  {
    slug: 'text-count',
    title: '字数统计',
    summary: '在浏览器里数字符、去空白、行数。文本不离开这台机器。',
  },
];
