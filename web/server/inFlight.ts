/**
 * Gộp các việc đang chạy theo khóa, ví dụ hai yêu cầu quét cùng một video gửi tới cùng lúc (bấm hai lần, hai tab, hai người):
 * yêu cầu sau dùng chung kết quả của yêu cầu đầu thay vì gửi AudD lần nữa và trả phí hai lần.
 */

export function createInFlight<T>() {
  const running = new Map<string, Promise<T>>();

  return {
    /** Việc đang chạy cho khóa này, nếu có. */
    get(key: string): Promise<T> | undefined {
      return running.get(key);
    },

    /**
     * Bắt đầu việc và ghi nhận ngay, trước mọi lệnh await, để yêu cầu tới sau thấy được. Việc xong hay lỗi thì xóa khóa.
     * Lỗi của việc vẫn trả cho người gọi; không ai chờ thì cũng không thành lỗi chưa xử lý.
     */
    run(key: string, work: () => Promise<T>): Promise<T> {
      const promise = work();
      running.set(key, promise);
      promise
        .finally(() => {
          if (running.get(key) === promise) {
            running.delete(key);
          }
        })
        .catch(() => undefined);
      return promise;
    },
  };
}
