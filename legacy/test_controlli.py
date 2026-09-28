from riassumi_libro import controlli, sistema_formato

originale = "The EU is highly uni- ﬁed and “confederal” rather than federal. " * 40
ok = 'The EU is "highly unified and “confederal”" in structure.'
assert [p[:9] for p in controlli(ok, originale)] == ["lunghezza"], controlli(ok, originale)
problemi = controlli('A "wrong winner" case [Yale].', originale)
assert any("wrong winner" in p for p in problemi) and any("[Yale]" in p for p in problemi), problemi

bozza = "# Title\n**[Author]** – in [x], pp. [1]\n---\n## Intro  \ntext"
atteso = "# Title\n\n**A** – *B*, pp. 9–29\n\n---\n\n## Intro\n\ntext"
assert sistema_formato(bozza, "**A** – *B*, pp. 9–29") == atteso, sistema_formato(bozza, "**A** – *B*, pp. 9–29")
print("ok")

# cambio pagina e legatura spezzata nel PDF non devono dare falsi positivi
pdf = "Switzerland “most clearly typiﬁ es the traits characteristic of liberal \nCONSENSUS MODEL OF DEMOCRACY  45\ncorporatism.” " * 50
assert not any("citazione" in p for p in controlli('It "most clearly typifies the traits characteristic of **liberal corporatism**."', pdf))
assert any("citazione" in p for p in controlli('It "clearly embodies a wholly different model of pluralist politics".', pdf))
print("ok 2")

# virgolette miste: “ ” del modello e " dritte non vanno abbinate tra loro
misto = 'A "most clearly typifies the traits" claim and then “democratic drift” here.'
assert not any("citazione" in p for p in controlli(misto, "most clearly typifies the traits and democratic drift " * 60)), controlli(misto, "most clearly typifies the traits and democratic drift " * 60)
print("ok 3")

assert sistema_formato("# THE CONSEQUENCES OF DEMOCRATIZATION\n## Introduction\ntext", None) == \
    "# The Consequences of Democratization\n\n## Introduction\n\ntext", sistema_formato("# THE CONSEQUENCES OF DEMOCRATIZATION\n## Introduction\ntext", None)
print("ok 4")
