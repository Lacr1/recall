# Fernhill catalogue migration - working notes

- Export from LibraSys finished: 186,412 records in MARC21.
- About 4% of records have duplicate ISBNs, mostly large print and audiobook editions catalogued as the same item.
- 2,300 records have no subject headings at all; branch staff added local notes in the wrong field.
- OpenShelf import accepts MARC but drops field 590 (local notes). Plan: map 590 to a custom "branch note" field.
- Bray and Greystones branches want to keep their local history collections searchable separately.
- Test import of 10,000 records took 11 minutes.
- Training plan: two half-day sessions per branch in January, recorded for part-time staff.
