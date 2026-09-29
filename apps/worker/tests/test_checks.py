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
