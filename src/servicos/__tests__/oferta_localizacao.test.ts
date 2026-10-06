import { describe, it, expect } from 'vitest';
import { tipoParaOferecer, artigoUnidade } from '../oferta_localizacao.js';

describe('oferta de unidade próxima (WhatsApp e app)', () => {
  it('emergência oferece hospital', () => {
    expect(tipoParaOferecer({ tipo: 'orientacao', decisao: { resposta_id: 'emergencia_001' } })).toBe('HOSPITAL');
  });

  it('UBS e UPA oferecem a própria unidade', () => {
    expect(tipoParaOferecer({ tipo: 'orientacao', decisao: { resposta_id: 'ubs_001' } })).toBe('UBS');
    expect(tipoParaOferecer({ tipo: 'orientacao', decisao: { resposta_id: 'upa_001' } })).toBe('UPA');
  });

  it('pergunta ou resposta sem unidade não oferece nada', () => {
    expect(tipoParaOferecer({ tipo: 'perguntas' })).toBeNull();
    expect(tipoParaOferecer({ tipo: 'orientacao', decisao: { resposta_id: 'mental_caps_001' } })).toBeNull();
  });

  it('artigo concorda com a unidade', () => {
    expect(artigoUnidade('HOSPITAL')).toEqual({ art: 'o', prox: 'próximo', nome: 'hospital' });
    expect(artigoUnidade('UPA')).toEqual({ art: 'a', prox: 'próxima', nome: 'UPA' });
  });
});
