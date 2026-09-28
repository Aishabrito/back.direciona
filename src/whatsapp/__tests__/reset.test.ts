import { describe, it, expect } from 'vitest';
import { ehComandoReset } from '../bot.js';

describe('comando de recomeçar', () => {
  it.each(['início', 'inicio', 'Início!', 'menu', 'recomeçar', 'novo atendimento', 'voltar ao começo', '/reset', '/rest'])(
    '"%s" reinicia', (t) => expect(ehComandoReset(t)).toBe(true),
  );
  it.each(['meu', 'mes', 'medo', 'meio', 'menos', 'inicial', '0', 'sim'])(
    '"%s" NÃO reinicia (resposta comum na triagem)', (t) => expect(ehComandoReset(t)).toBe(false),
  );
});
