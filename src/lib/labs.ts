export type Lab = {
  slug: string;
  title: string;
  summary: string;
};

export const labs: Lab[] = [
  {
    slug: 'grid-trading',
    title: '网格交易计算器',
    summary: '按历史日线高低价回测 ETF / A 股网格的买卖触发与盈亏。',
  },
  {
    slug: 'text-count',
    title: '字数统计',
    summary: '在浏览器里数字符、去空白、行数。文本不离开这台机器。',
  },
];
