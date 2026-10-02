from summarize_worker.checks import fix_format, run_checks

ORIGINAL = "The EU is highly uni- ﬁed and “confederal” rather than federal. " * 40


def test_verbatim_quote_passes_only_length_flagged():
    ok = 'The EU is "highly unified and “confederal”" in structure.'
    assert [p.split()[0] for p in run_checks(ok, ORIGINAL)] == ["length"]


def test_invented_quote_and_leftover_brackets_are_flagged():
    problems = run_checks('A "wrong winner" case [Yale].', ORIGINAL)
    assert any("wrong winner" in p for p in problems) and any("[Yale]" in p for p in problems)


def test_fix_format_header_and_spacing():
    draft = "# Title\n**[Author]** – in [x], pp. [1]\n---\n## Intro  \ntext"
    assert fix_format(draft, "**A** – *B*, pp. 9–29") == "# Title\n\n**A** – *B*, pp. 9–29\n\n---\n\n## Intro\n\ntext"


def test_page_header_and_split_ligature_do_not_break_quotes():
    pdf = "Switzerland “most clearly typiﬁ es the traits characteristic of liberal \nCONSENSUS MODEL OF DEMOCRACY  45\ncorporatism.” " * 50
    assert not any("quote" in p for p in run_checks('It "most clearly typifies the traits characteristic of **liberal corporatism**."', pdf))
    assert any("quote" in p for p in run_checks('It "clearly embodies a wholly different model of pluralist politics".', pdf))


def test_mixed_quote_styles_are_not_paired():
    mixed = 'A "most clearly typifies the traits" claim and then “democratic drift” here.'
    assert not any("quote" in p for p in run_checks(mixed, "most clearly typifies the traits and democratic drift " * 60))


def test_all_caps_heading_becomes_title_case():
    assert fix_format("# THE CONSEQUENCES OF DEMOCRATIZATION\n## Introduction\ntext", None) == \
        "# The Consequences of Democratization\n\n## Introduction\n\ntext"


def test_length_target_follows_length_percent():
    original = "word " * 1000
    assert run_checks("x " * 200, original, length_percent=20) == []
    assert [p.split()[0] for p in run_checks("x " * 200, original, length_percent=33)] == ["length"]


def test_fix_format_inserts_header_after_h1_and_replaces_model_written_line():
    h = "**A** – *B*, pp. 9–29"
    assert fix_format("# T\n\n## Intro\ntext", h) == f"# T\n\n{h}\n\n## Intro\n\ntext"
    assert fix_format("# T\n**Smith** – in Book, pp. 1–2\n## Intro\ntext", h) == f"# T\n\n{h}\n\n## Intro\n\ntext"
    assert fix_format("# T\n## Intro\ntext", None) == "# T\n\n## Intro\n\ntext"


def test_glued_footnote_markers_do_not_break_quotes_but_invented_ones_still_flag():
    pdf = "The Prime Minister,3 the Council and its members.12 Later in 1970 the cabinet fell. " * 40
    ok = 'He wrote "the Prime Minister, the Council and its members. Later in 1970 the cabinet fell".'
    assert not any("quote" in p for p in run_checks(ok, pdf))
    assert any("quote" in p for p in run_checks('He wrote "a completely invented sentence about nothing at all".', pdf))
    # standalone numbers (years) are kept: a quote with a different number still fails
    assert any("quote" in p for p in run_checks('He wrote "Later in 1 the cabinet fell and the Council met twice".', pdf))


def test_thousands_and_decimals_are_not_mistaken_for_footnotes():
    pdf = "There were 1,000 men and a ratio of 3.14 to one in the field. " * 40
    assert not any("quote" in p for p in run_checks('It says "there were 1,000 men and a ratio of 3.14 to one".', pdf))


def test_fix_format_is_idempotent_with_a_header_lacking_in_and_pp():
    h = "**Smith** – *Book*, p. 5"
    once = fix_format("# T\n## Intro\ntext", h)
    assert fix_format(once, h) == once and once.count(h) == 1


def test_highlight_marks_are_ignored_by_checks_and_dropped_from_headings():
    ok = 'The EU is ==“highly unified and “confederal”==" in structure.'.replace('==“', '=="')
    assert [p.split()[0] for p in run_checks(ok, ORIGINAL)] == ["length"]
    assert run_checks("a ==b c== d", "a b c d", 100) == []
    assert fix_format("## ==Title==\n==Key.==", None) == "## Title\n\n==Key.=="
