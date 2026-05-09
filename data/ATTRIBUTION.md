# Data Provenance & Attribution

This document details the origin and licensing of all third-party data integrated into integrity.molt.

## SolRPDS (Solana Rug Pull Dataset)

### Source
- **Repository:** https://github.com/DeFiLabX/SolRPDS
- **Paper:** https://doi.org/10.1145/3714393.3726487
- **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### Citation

Alhaidari, A., Kalal, B., Palanisamy, B., & Sural, S. (2025). SolRPDS: A Dataset for Analyzing Rug Pulls in Solana Decentralized Finance. In *Proceedings of the Fifteenth ACM Conference on Data and Application Security and Privacy (CODASPY '25)* (pp. 293–298). Association for Computing Machinery. https://doi.org/10.1145/3714393.3726487

### What the dataset contains

SolRPDS is derived from 3.69 billion Solana blockchain transactions over the period February 12, 2021 to November 1, 2024. The full dataset contains:

- 63,520 unique liquidity pool addresses
- 33,746 unique token MINTs
- 22,195 tokens flagged as inactive (rug pull pattern)
- 11,551 tokens still active as of cutoff date

### What integrity.molt uses

integrity.molt imports **33,359 unique MINT addresses** from SolRPDS into the `known_scams` table with `source = 'solrpds'`. The mint-keyed indexing reflects integrity.molt's primary use case: counterparty risk lookups by token mint, not pool-level analytics.

### Modifications

- **No SolRPDS records were altered.** The 33,359 imported entries match the source dataset's MINT addresses one-to-one.
- **Schema augmentation only:** integrity.molt added columns (`source`, `add_to_remove_ratio`, `inactivity_days`, `flagged_at`) to `known_scams` to support multi-source intelligence aggregation. SolRPDS-derived rows have `source = 'solrpds'`.
- **Coverage gap:** SolRPDS dataset has a cutoff of November 1, 2024. Post-cutoff Solana rug pulls are not included in the imported baseline. integrity.molt addresses this gap through (a) live signals from RugCheck, Solana Tracker, and OtterSec APIs, and (b) a Bitquery-based DEX liquidity monitoring pipeline that applies SolRPDS paper's deterministic methodology (sections 4.2-4.3) to post-cutoff data.

### How to verify attribution

The attribution can be verified at three levels:

1. **Repository level:** This file (`data/ATTRIBUTION.md`), `NOTICE` in repo root, and the Acknowledgments section in `README.md`.
2. **API response level:** When `scan_address` skill returns a flagged token, the response includes a `source` field indicating whether the flag originates from SolRPDS or from live signals.
3. **Database level:** `SELECT source, COUNT(*) FROM known_scams GROUP BY source` shows the breakdown of records by origin.

## License compatibility

integrity.molt is licensed under MIT. SolRPDS is licensed under CC BY 4.0. These licenses are compatible: integrity.molt may incorporate CC BY 4.0 data and redistribute under MIT, provided attribution requirements are met (which this document satisfies).
