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
    slug: 'grid-trading/saved',
    title: '网格列表',
    summary: '查看已保存的网格回测标的：当前状态、备份对比与成交明细。',
  },
];
