# A link in pi's reply is a hyperlink on the Stage, though pi started before any terminal attached to tell it so.
Source common.tape

Type "# a link pi prints reaches the terminal as a hyperlink, not as text" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "reply see [the docs](mailto:ops@example.com) for the deploy steps" Sleep 400ms Enter
Wait+Screen /(?s)deploy steps.*deploy steps/
Sleep 1s
Screenshot ../artifacts/phase6/videos/links.png
Sleep 2s
