import { EventEmitter } from "events";

import { exitWhenClientDisconnects } from "./lifecycle";

describe("exitWhenClientDisconnects", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it("exits with code 0 after stdin ends", () => {
    const stdin = new EventEmitter();
    exitWhenClientDisconnects(stdin);

    stdin.emit("end");

    expect(exitSpy).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits once when both end and close fire", () => {
    const stdin = new EventEmitter();
    exitWhenClientDisconnects(stdin);

    stdin.emit("end");
    stdin.emit("close");
    jest.runAllTimers();

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("stays alive while the client is connected", () => {
    const stdin = new EventEmitter();
    exitWhenClientDisconnects(stdin);

    jest.runAllTimers();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
