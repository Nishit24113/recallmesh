# RecallMesh — Bond Sizing

How large should the per-unit bond (`bondPerUnit`, written *b* below) and the liability period
(`liabilityPeriod`, *T*) be? This note gives the model behind the contract parameters. The numbers
are illustrative; real values depend on the product category.

## Mechanism recap

- Producing a lot of *q* units locks *b·q* of the producer's bond for time *T*.
- If that lot is recalled within *T*, the whole lock *b·q* is slashed. After *T* the lock can be
  released, and a recall then falls back to whatever free bond remains.
- The slashed amount is split pro-rata among downstream holders by quarantined units.

## 1. Deterrence (incentive compatibility)

Suppose a producer can save *s* per unit by skipping a safety control. Skipping raises the chance
that the lot is defective by Δ*p*, and a defect is detected and recalled within *T* with
probability *d*. Skipping is unprofitable when the expected slash exceeds the saving:

  *s* < Δ*p* · *d* · *b*  ⇔  ***b* > *s* / (Δ*p* · *d*)**

So the bond must grow when detection is unreliable (small *d*) or when shortcuts save a lot (large
*s*). *T* enters through *d*: a period shorter than typical detection latency drives *d*, and with
it the deterrent, toward zero.

## 2. Compensation coverage

One unit of a root lot feeds roughly α downstream units, where α is the amplification through the
DAG (mixing, repacking, fan-out). Let *c* be the loss per affected downstream unit (disposal,
logistics, lost margin). Downstream holders are fully compensated when

  *b* · *q* ≥ α · *c* · *q*  ⇔  ***b* ≥ α · *c***

The coverage ratio *b* / (α·*c*) is reported per recall: the slashed amount is on-chain, and the
quarantined units are the sum of the payout weights.

## 3. Capital cost

Locked collateral has an opportunity cost at rate *r*. In steady state a producer with throughput
θ units per unit time keeps *b*·θ·*T* locked, which costs

  *r* · *b* · θ · *T*  per unit time,  i.e.  ***r* · *b* · *T*** per unit produced.

This is the price of credible liability. It argues for a short *T* (just longer than detection
latency) and for *b* close to the larger of the deterrence and coverage bounds, but no larger.

## 4. Choosing the defaults

| Parameter | Default | Rationale |
|---|---|---|
| `liabilityPeriod` | 30 days | Covers shelf life plus reporting lag for fresh produce, the demo's product class. Longer-lived goods (pharmaceuticals, electronics) need a longer *T*. |
| `bondPerUnit` (local) | 0.01 ETH | Large enough to make demo payouts readable. |
| `bondPerUnit` (Amoy) | 0.0001 POL | Fits testnet faucet limits. Only the ratios matter for the demo. |

Illustrative calculation: with *s* = $0.05/unit saved, Δ*p* = 2%, and *d* = 0.5, deterrence needs
*b* > $5/unit. With α = 3 and *c* = $1.50/unit, coverage needs *b* ≥ $4.50/unit. At *r* = 8%/yr
and *T* = 30 days, a $5 bond costs about $0.033 per unit produced, which is less than the $0.05
saving it deters. The mechanism is economically viable when detection is reasonably likely.

## 5. Limitations and extensions

- **One rate for every product and role.** A risk-weighted `bondPerUnit` (per product class or
  per actor track record) would tighten both bounds.
- **Only the root producer pays.** When several upstream inputs share blame, liability could be
  split by input share along the lineage.
- **Bond can be exhausted.** A recall after release slashes only the remaining free bond. An
  insurance pool or mutual fund could backstop coverage.
- **Detection probability is external.** *d* depends on the oracle (testing frequency and
  regulator reach), which the contracts cannot raise.
