// T-028d PDF 文本分组纯函数单测（不 import pdfjs）。
import { describe, expect, it } from 'vitest';
import { groupPdfText, type PdfTextItem } from '../../../src/shared/pdf-text';

function item(
  str: string,
  x: number,
  y: number,
  width = 60,
  height = 10,
): PdfTextItem {
  return { str, transform: [height, 0, 0, height, x, y], width, height };
}

describe('groupPdfText / 空页与行内拼接', () => {
  it('空页返回空 lines/blocks 和 columns=1', () => {
    expect(groupPdfText([], 4)).toEqual({
      page: 4,
      columns: 1,
      lines: [],
      blocks: [],
    });
  });

  it('按 x 排序并只在真实间距处补空格', () => {
    const page = groupPdfText([
      item('world', 90, 700, 40),
      item('Hello', 40, 700, 45),
      item('!', 133, 700, 5),
    ]);
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]?.text).toBe('Hello world!');
  });

  it('同一行相邻 item 不额外插入空格', () => {
    const page = groupPdfText([
      item('Hel', 40, 700, 20),
      item('lo', 60, 700, 12),
      item('world', 72, 700, 30),
    ]);
    expect(page.lines[0]?.text).toBe('Helloworld');
  });
});

describe('groupPdfText / 段落判定', () => {
  it('正常行距并成同一段', () => {
    const page = groupPdfText([
      item('This is a', 40, 700, 80),
      item('wrapped line', 40, 688, 80),
    ]);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.text).toBe('This is a wrapped line');
    expect(page.blocks[0]?.lineCount).toBe(2);
  });

  it('大行距另起一段', () => {
    const page = groupPdfText([
      item('First paragraph.', 40, 700, 120),
      item('Second paragraph.', 40, 680, 140),
    ]);
    expect(page.blocks.map((block) => block.text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
    ]);
    expect(page.blocks).toHaveLength(2);
  });

  it('首行缩进且上一行较短时另起一段', () => {
    const page = groupPdfText([
      item('Short end.', 40, 700, 80),
      item('Indented start.', 64, 688, 140),
    ]);
    expect(page.blocks).toHaveLength(2);
    expect(page.blocks.map((block) => block.text)).toEqual([
      'Short end.',
      'Indented start.',
    ]);
  });

  it('列表符另起一段', () => {
    const page = groupPdfText([
      item('Intro paragraph.', 40, 700, 120),
      item('• first item', 40, 688, 80),
      item('• second item', 40, 676, 90),
    ]);
    expect(page.blocks.length).toBeGreaterThanOrEqual(2);
    expect(page.blocks[0]?.text).toBe('Intro paragraph.');
  });

  it('字号变化另起一段', () => {
    const page = groupPdfText([
      item('Big Heading', 40, 700, 100, 16),
      item('Body text.', 40, 680, 80, 10),
    ]);
    expect(page.blocks).toHaveLength(2);
    expect(page.blocks.map((block) => block.text)).toEqual([
      'Big Heading',
      'Body text.',
    ]);
  });
});

describe('groupPdfText / 英文连字符与标点', () => {
  it('行末连字符 + 小写开头 → 去掉连字符并合词', () => {
    const page = groupPdfText([
      item('trans-', 40, 700, 40),
      item('lation', 40, 688, 40),
    ]);
    expect(page.blocks[0]?.text).toBe('translation');
  });

  it('行末连字符 + 大写开头 → 保留连字符', () => {
    const page = groupPdfText([
      item('Anglo-', 40, 700, 45),
      item('Saxon', 40, 688, 40),
    ]);
    expect(page.blocks[0]?.text).toBe('Anglo-Saxon');
  });

  it('软连字符跨行直接合词，不留下空格', () => {
    const page = groupPdfText([
      item('co\u00ad', 40, 700, 20),
      item('operate', 40, 688, 40),
    ]);
    expect(page.blocks[0]?.text).toBe('cooperate');
  });

  it('标点前不补空格，逗号后按间距补空格', () => {
    const page = groupPdfText([
      item('Hello', 40, 700, 30),
      item(',', 72, 700, 5),
      item('world', 82, 700, 30),
    ]);
    expect(page.lines[0]?.text).toBe('Hello, world');
  });
});

describe('groupPdfText / CJK', () => {
  it('中文 item 之间与跨行都不插空格', () => {
    const page = groupPdfText([
      item('双语', 40, 700, 30, 12),
      item('阅读', 74, 700, 24, 12),
      item('阅读器', 40, 686, 36, 12),
    ]);
    expect(page.lines.map((line) => line.text)).toEqual([
      '双语阅读',
      '阅读器',
    ]);
    expect(page.blocks[0]?.text).toBe('双语阅读阅读器');
  });

  it('中文标点不产生空格', () => {
    const page = groupPdfText([
      item('你好', 40, 700, 20, 12),
      item('，世界。', 64, 700, 40, 12),
    ]);
    expect(page.lines[0]?.text).toBe('你好，世界。');
  });
});

describe('groupPdfText / 双栏', () => {
  const twoColumnItems = [
    item('Alpha', 40, 700, 100),
    item('Beta', 145, 700, 100),
    item('Gamma', 320, 700, 100),
    item('Delta', 425, 700, 100),
    item('Epsilon', 40, 688, 100),
    item('Zeta', 145, 688, 100),
    item('Eta', 320, 688, 100),
    item('Theta', 425, 688, 100),
  ];

  it('识别双栏并按左栏、右栏分别成段', () => {
    const page = groupPdfText(twoColumnItems);
    expect(page.columns).toBe(2);
    expect(page.blocks.map((block) => block.text)).toEqual([
      'Alpha Beta Epsilon Zeta',
      'Gamma Delta Eta Theta',
    ]);
  });

  it('通栏标题先于双栏正文，column=0', () => {
    const page = groupPdfText([
      item('Two Column Paper', 40, 720, 485),
      ...twoColumnItems,
    ]);
    expect(page.columns).toBe(2);
    expect(page.blocks.map((block) => block.text)).toEqual([
      'Two Column Paper',
      'Alpha Beta Epsilon Zeta',
      'Gamma Delta Eta Theta',
    ]);
    expect(page.blocks[0]?.column).toBe(0);
  });
});

describe('groupPdfText / 表格', () => {
  it('一行三列保持同一行，不误拆成栏', () => {
    const page = groupPdfText([
      item('Name', 40, 700, 60),
      item('Count', 200, 700, 60),
      item('Note', 360, 700, 60),
    ]);
    expect(page.columns).toBe(1);
    expect(page.lines[0]?.text).toBe('Name Count Note');
    expect(page.blocks[0]?.text).toBe('Name Count Note');
  });

  it('多行表格按行保留，行距正常时并段', () => {
    const page = groupPdfText([
      item('Name', 40, 700, 60),
      item('Count', 200, 700, 60),
      item('Note', 360, 700, 60),
      item('Alpha', 40, 686, 60),
      item('3', 200, 686, 20),
      item('ok', 360, 686, 30),
    ]);
    expect(page.columns).toBe(1);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.text).toBe('Name Count Note Alpha 3 ok');
  });
});

describe('groupPdfText / 输出元数据', () => {
  it('页码与 block id 稳定，便于 T-028e 落位', () => {
    const page = groupPdfText([item('Hello', 40, 700, 30)], 7);
    expect(page.page).toBe(7);
    expect(page.blocks[0]?.id).toBe('p7-c1-b1');
    expect(page.lines[0]?.page).toBe(7);
  });

  it('块外接矩形覆盖所有行，y 取块顶（T-029 角标定位）', () => {
    const page = groupPdfText([
      item('This is a', 40, 700, 80),
      item('wrapped line', 40, 688, 80),
    ]);
    expect(page.blocks[0]?.rect).toEqual({ x: 40, y: 710, width: 80, height: 22 });
  });

  it('缩进行把矩形左缘拉到 x=40，而不是首行缩进位置', () => {
    const page = groupPdfText([
      item('Indented start of paragraph.', 56, 700, 120),
      item('Second line aligned left.', 40, 688, 130),
    ]);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.rect).toEqual({ x: 40, y: 710, width: 136, height: 22 });
  });
});
