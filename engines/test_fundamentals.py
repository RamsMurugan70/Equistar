"""Industry-relative fundamentals. Run: python -m unittest test_fundamentals  (from engines/)

No network: every input is a hand-built raw dict, the shape fundamental_raw() returns.
"""
import unittest

import portfolio_health as ph


def raw(pe=None, pb=None, roe=None, de=None, revg=None, eps=1.0):
    return {'pe': pe, 'fpe': None, 'eps': eps, 'pb': pb, 'roe': roe, 'de': de, 'revg': revg}


def industry(name, n, pe_base, sym_prefix):
    """n companies whose metrics improve with their index; P/E levels set per industry."""
    out = {}
    for i in range(n):
        out[f'{sym_prefix}{i}'] = raw(pe=pe_base + 2 * (n - i), pb=1 + 0.2 * (n - i),
                                      roe=0.05 + 0.02 * i, de=100 - 5 * i, revg=0.01 * i)
    return out, {s: name for s in out}


class IndustryRelative(unittest.TestCase):
    def setUp(self):
        # Refiners trade near 8x, consumer brands near 55x — the same quality ladder in each.
        oil, oil_ind = industry('Oil Gas & Consumable Fuels', 10, 6, 'OIL')
        fmcg, fmcg_ind = industry('Fast Moving Consumer Goods', 10, 50, 'FMCG')
        self.raw = {**oil, **fmcg}
        self.ind = {**oil_ind, **fmcg_ind}

    def test_sector_level_does_not_decide_the_score(self):
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        oil_avg = sum(out[f'OIL{i}']['score'] for i in range(10)) / 10
        fmcg_avg = sum(out[f'FMCG{i}']['score'] for i in range(10)) / 10
        self.assertAlmostEqual(oil_avg, fmcg_avg, places=1)
        # The best FMCG company scores like the best refiner, despite a P/E six times higher.
        self.assertEqual(out['OIL9']['score'], out['FMCG9']['score'])
        # Whereas the old fixed thresholds favour the whole oil industry.
        legacy_oil = sum(ph.legacy_fundamental_from_raw(self.raw[f'OIL{i}'], False) for i in range(10)) / 10
        legacy_fmcg = sum(ph.legacy_fundamental_from_raw(self.raw[f'FMCG{i}'], False) for i in range(10)) / 10
        self.assertGreater(legacy_oil, legacy_fmcg + 5)

    def test_loss_maker_ranks_last_on_pe(self):
        self.raw['OIL5'] = {**self.raw['OIL5'], 'pe': None, 'eps': -3.0}
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        self.assertEqual(out['OIL5']['parts']['pe'], 0.0)

    def test_negative_book_ranks_last_on_pb(self):
        self.raw['OIL5'] = {**self.raw['OIL5'], 'pb': -2.0}
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        self.assertEqual(out['OIL5']['parts']['pb'], 0.0)

    def test_financials_are_not_scored_on_leverage(self):
        bank, bank_ind = industry('Financial Services', 10, 10, 'BNK')
        self.raw.update(bank)
        self.ind.update(bank_ind)
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        self.assertNotIn('de', out['BNK3']['parts'])
        self.assertIn('de', out['OIL3']['parts'])

    def test_thin_industry_falls_back_to_pool_and_says_so(self):
        self.raw['LONE'] = raw(pe=20, pb=2, roe=0.15, de=40, revg=0.1)
        self.ind['LONE'] = 'Textiles'
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        self.assertEqual(set(out['LONE']['basis'].values()), {'pool'})
        self.assertEqual(set(out['OIL0']['basis'].values()), {'industry'})

    def test_too_few_metrics_is_no_score(self):
        self.raw['SPARSE'] = raw(pe=10, roe=0.2)
        self.ind['SPARSE'] = 'Oil Gas & Consumable Fuels'
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        self.assertIsNone(out['SPARSE']['score'])

    def test_scores_stay_on_0_to_100(self):
        out = ph.industry_relative_fundamentals(self.raw, self.ind)
        for v in out.values():
            self.assertTrue(0 <= v['score'] <= 100)


if __name__ == '__main__':
    unittest.main()
