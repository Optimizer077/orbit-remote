namespace Orbit.Host;

/// <summary>Capacity includes native opens in progress and resources still disposing.</summary>
internal sealed class VideoStreamAdmission<T>(int capacity = 8, int perDeviceCapacity = 4) where T : class
{
    private readonly object gate = new();
    private readonly Dictionary<(string Session, string Monitor), Entry> entries = [];
    private sealed class Entry(string deviceId)
    {
        public string DeviceId { get; } = deviceId;
        public Reservation? Current;
        public Reservation? Pending;
    }

    public int Count { get { lock (gate) return entries.Count; } }

    public Reservation? TryReserve(string deviceId, string sessionId, string monitorId)
    {
        lock (gate)
        {
            var key = (sessionId, monitorId);
            if (entries.TryGetValue(key, out var existing))
            {
                // An opening stream cannot itself be replaced. One successor at a time
                // retains the old admission position until its resources are released.
                if (existing.DeviceId != deviceId || existing.Pending is not null || existing.Current?.Stream is not { } previous)
                    return null;
                return existing.Pending = new(this, key, previous, existing.Current.Released);
            }
            if (entries.Count >= capacity || entries.Values.Count(entry => entry.DeviceId == deviceId) >= perDeviceCapacity)
                return null;
            var entry = new Entry(deviceId);
            var reservation = new Reservation(this, key, null, Task.CompletedTask);
            entry.Current = reservation; entries.Add(key, entry);
            return reservation;
        }
    }

    internal sealed class Reservation : IDisposable
    {
        private readonly VideoStreamAdmission<T> owner;
        private readonly (string Session, string Monitor) key;
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private bool disposed;
        internal T? Stream { get; private set; }
        internal Task Released => released.Task;
        public T? Previous { get; }
        public Task PreviousReleased { get; }

        internal Reservation(VideoStreamAdmission<T> owner, (string Session, string Monitor) key, T? previous, Task previousReleased)
        { this.owner = owner; this.key = key; Previous = previous; PreviousReleased = previousReleased; }

        public void Activate(T stream)
        {
            lock (owner.gate)
            {
                if (disposed || !owner.entries.TryGetValue(key, out var entry)) throw new InvalidOperationException("Stream admission has ended.");
                if (ReferenceEquals(entry.Pending, this))
                {
                    if (entry.Current is not null || !PreviousReleased.IsCompleted) throw new InvalidOperationException("Previous stream resources are still active.");
                    entry.Pending = null; entry.Current = this;
                }
                else if (!ReferenceEquals(entry.Current, this)) throw new InvalidOperationException("Stream admission was replaced.");
                if (Stream is not null) throw new InvalidOperationException("Stream admission is already active.");
                Stream = stream;
            }
        }

        public void Dispose()
        {
            lock (owner.gate)
            {
                if (disposed) return;
                disposed = true;
                if (owner.entries.TryGetValue(key, out var entry))
                {
                    if (ReferenceEquals(entry.Current, this)) entry.Current = null;
                    if (ReferenceEquals(entry.Pending, this)) entry.Pending = null;
                    if (entry.Current is null && entry.Pending is null) owner.entries.Remove(key);
                }
            }
            released.TrySetResult();
        }
    }
}
