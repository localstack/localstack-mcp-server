// A grandchild of the fake `az` that sleeps while holding its inherited pipes.
setTimeout(() => undefined, Number(process.argv[2] ?? 30000));
