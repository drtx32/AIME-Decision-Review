import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownText from './MarkdownText';

describe('MarkdownText', () => {
  it('renders bold, lists, tables, code, links and headings', () => {
    const html = renderToStaticMarkup(
      <MarkdownText text={'# 标题\n\n**重点** 与 *斜体*。\n\n- 第一条\n- 第二条\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n`code()` 与 [链接](https://example.com/x)。'} />,
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>第一条</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<code>');
    expect(html).toContain('href="https://example.com/x"');
  });

  it('never renders raw HTML', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'<script>alert(1)</script>正文内容'} />);
    expect(html).not.toContain('<script');
    expect(html).toContain('正文内容');
  });

  it('drops javascript:/data: links', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'[危险](javascript:alert(1)) 与 [数据](data:text/html,hi) 正常文字'} />);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('正常文字');
  });

  it('strips residual chain-of-thought defensively', () => {
    const secret = 'COT_SECRET_992';
    const text = `公开部分。\n\n\`\`\`think\n${secret}\n\`\`\`\n\n正常结尾。`;
    const html = renderToStaticMarkup(<MarkdownText text={text} />);
    expect(html).not.toContain(secret);
    expect(html).toContain('公开部分');
    expect(html).toContain('正常结尾');
  });

  it('strips XML-style thinking blocks', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'可见结论 <thinking>内部推理过程</thinking> 后续内容。'} />);
    expect(html).not.toContain('内部推理过程');
    expect(html).toContain('可见结论');
    expect(html).toContain('后续内容');
  });
});