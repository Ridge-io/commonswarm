import re
import os

with open('docs/design/2026-09-04-chat-platform-reconciled.md', 'r') as f:
    text = f.read()

# find all file:line references
# We will match pattern: word/word.ext:line(-line)? or just :line(-line)?
# If it's just :line, we use the last seen filename

citations = []
last_file = None

# A regex that finds either a full file citation or a line citation
# file citation: [a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+:\d+(?:-\d+)?
# line citation: :\d+(?:-\d+)?
# We must avoid matching things like https://... which has ://
# also time like 12:34

pattern = re.compile(r'([a-zA-Z0-9_\-\./]+?\.[a-zA-Z0-9]+):(\d+)(?:-(\d+))?|(?<=\s):(\d+)(?:-(\d+))?')

for m in pattern.finditer(text):
    if m.group(1):
        last_file = m.group(1)
        start = m.group(2)
        end = m.group(3) if m.group(3) else start
        citations.append((last_file, int(start), int(end)))
    else:
        start = m.group(4)
        end = m.group(5) if m.group(5) else start
        if last_file:
            citations.append((last_file, int(start), int(end)))

# Also check for explicit mentions like `file.ext`
# But the prompt says "Open the file at the cited path:line"

# We will read the file and print the lines
report = []
for file_path, start, end in citations:
    if os.path.exists(file_path):
        with open(file_path, 'r') as f:
            lines = f.readlines()
        content = ""
        for i in range(start-1, end):
            if i < len(lines):
                content += f"{i+1}: {lines[i].strip()}\n"
        report.append(f"--- {file_path}:{start}-{end} ---\n{content}\n")
    else:
        # Try to resolve if it's a relative path from somewhere
        # The prompt says "Every citation below was resolved in that tree."
        
        # Let's search for the file in the tree
        candidates = []
        for root, dirs, files in os.walk('.'):
            if file_path.startswith('/'): continue
            # if file_path is like "command/index.ts", it could be supabase/functions/command/index.ts
            if file_path.split('/')[-1] in files:
                full_path = os.path.join(root, file_path.split('/')[-1])
                if full_path.endswith(file_path):
                    candidates.append(full_path)
        
        if candidates:
            with open(candidates[0], 'r') as f:
                lines = f.readlines()
            content = ""
            for i in range(start-1, end):
                if i < len(lines):
                    content += f"{i+1}: {lines[i].strip()}\n"
            report.append(f"--- {file_path}:{start}-{end} (resolved to {candidates[0]}) ---\n{content}\n")
        else:
            report.append(f"--- {file_path}:{start}-{end} ---\nFILE NOT FOUND\n\n")

with open('citation_report.txt', 'w') as f:
    f.write("".join(report))
