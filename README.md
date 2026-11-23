# Mock Exam App

A browser-based practice exam builder. It samples questions from a JSON bank, runs timed or untimed exams, and shows scores and answer explanations after submission. Progress and attempt history stay in the browser.

## Run locally

With Python 3 installed, start a server from the repository root.

```sh
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). Add questions to the root [`questions.json`](questions.json) to enable exam setup.
