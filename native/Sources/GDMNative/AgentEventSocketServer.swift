import Darwin
import Foundation

enum AgentEventSocketError: LocalizedError, Equatable {
    case pathTooLong
    case invalidResponse
    case createDirectory(Int32)
    case createSocket(Int32)
    case bind(Int32)
    case listen(Int32)
    case permissions(Int32)

    var errorDescription: String? {
        switch self {
        case .pathTooLong: "Agent event socket path exceeds the UNIX socket limit."
        case .invalidResponse: "Agent event socket returned an invalid response."
        case .createDirectory(let code): "Could not create the private agent event directory (errno \(code))."
        case .createSocket(let code): "Could not create the agent event socket (errno \(code))."
        case .bind(let code): "Could not bind the agent event socket (errno \(code))."
        case .listen(let code): "Could not listen on the agent event socket (errno \(code))."
        case .permissions(let code): "Could not protect the agent event socket (errno \(code))."
        }
    }
}

/// A local, newline-delimited JSON transport for explicit agent state events.
/// It accepts only the current effective UID and never reads terminal output.
final class AgentEventSocketServer: @unchecked Sendable {
    typealias Handler = @Sendable (AgentEventEnvelope) async -> AgentEventReceipt

    static let maximumRequestBytes = 65_536

    let socketURL: URL
    let directoryURL: URL

    private let handler: Handler
    private let listenerDescriptor: Int32
    private let acceptQueue = DispatchQueue(label: "com.gidem.agent-events.accept")
    private let connectionQueue = DispatchQueue(
        label: "com.gidem.agent-events.connections",
        attributes: .concurrent
    )
    private let lock = NSLock()
    private var source: DispatchSourceRead?
    private var connectionDescriptors: Set<Int32> = []
    private var stopped = false

    init(handler: @escaping Handler) throws {
        self.handler = handler
        // Darwin's sockaddr_un.sun_path is only 104 bytes. `/tmp` keeps the
        // bound path short even when the process temporary directory is long.
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)
        let directory = URL(fileURLWithPath: "/tmp", isDirectory: true).appendingPathComponent(
            "gdm-\(geteuid())-\(nonce)",
            isDirectory: true
        )
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            throw AgentEventSocketError.createDirectory(errno)
        }
        directoryURL = directory
        socketURL = directory.appendingPathComponent("events.sock", isDirectory: false)

        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            try? FileManager.default.removeItem(at: directory)
            throw AgentEventSocketError.createSocket(errno)
        }
        listenerDescriptor = descriptor

        do {
            try Self.bind(descriptor: descriptor, path: socketURL.path)
            guard Darwin.listen(descriptor, 32) == 0 else {
                throw AgentEventSocketError.listen(errno)
            }
            guard chmod(socketURL.path, 0o600) == 0 else {
                throw AgentEventSocketError.permissions(errno)
            }
            _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        } catch {
            Darwin.close(descriptor)
            try? FileManager.default.removeItem(at: directory)
            throw error
        }

        let source = DispatchSource.makeReadSource(
            fileDescriptor: descriptor,
            queue: acceptQueue
        )
        source.setEventHandler { [weak self] in self?.acceptConnections() }
        source.setCancelHandler { Darwin.close(descriptor) }
        self.source = source
        source.resume()
    }

    deinit { stop() }

    func stop() {
        let state = lock.withLock { () -> (DispatchSourceRead?, [Int32], Bool) in
            guard !stopped else { return (nil, [], false) }
            stopped = true
            let descriptors = Array(connectionDescriptors)
            connectionDescriptors.removeAll()
            let activeSource = source
            source = nil
            return (activeSource, descriptors, true)
        }
        guard state.2 else { return }
        state.0?.cancel()
        for descriptor in state.1 {
            Darwin.shutdown(descriptor, SHUT_RDWR)
            Darwin.close(descriptor)
        }
        try? FileManager.default.removeItem(at: directoryURL)
    }

    private static func bind(descriptor: Int32, path: String) throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else { throw AgentEventSocketError.pathTooLong }
        withUnsafeMutablePointer(to: &address.sun_path) { tuplePointer in
            let destination = UnsafeMutableRawPointer(tuplePointer)
                .assumingMemoryBound(to: CChar.self)
            path.withCString { source in
                _ = strncpy(destination, source, capacity - 1)
            }
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw AgentEventSocketError.bind(errno) }
    }

    private func acceptConnections() {
        while true {
            let descriptor = Darwin.accept(listenerDescriptor, nil, nil)
            if descriptor < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                return
            }
            let flags = fcntl(descriptor, F_GETFL)
            if flags >= 0 { _ = fcntl(descriptor, F_SETFL, flags & ~O_NONBLOCK) }
            let shouldHandle = lock.withLock { () -> Bool in
                guard !stopped else { return false }
                connectionDescriptors.insert(descriptor)
                return true
            }
            guard shouldHandle else {
                Darwin.close(descriptor)
                continue
            }
            connectionQueue.async { [weak self] in self?.readRequest(from: descriptor) }
        }
    }

    private func readRequest(from descriptor: Int32) {
        var peerUID = uid_t()
        var peerGID = gid_t()
        guard getpeereid(descriptor, &peerUID, &peerGID) == 0,
              peerUID == geteuid() else {
            finish(descriptor)
            return
        }

        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        _ = withUnsafePointer(to: &timeout) {
            setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_RCVTIMEO,
                $0,
                socklen_t(MemoryLayout<timeval>.size)
            )
        }

        var request = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while request.count <= Self.maximumRequestBytes {
            let count = buffer.withUnsafeMutableBytes { bytes in
                recv(descriptor, bytes.baseAddress, bytes.count, 0)
            }
            if count <= 0 { break }
            request.append(contentsOf: buffer.prefix(count))
            if request.contains(0x0A) { break }
        }
        guard request.count <= Self.maximumRequestBytes,
              let newline = request.firstIndex(of: 0x0A) else {
            send(.rejected(.invalidPayload), to: descriptor)
            finish(descriptor)
            return
        }
        let line = request[..<newline]
        let event: AgentEventEnvelope
        do {
            event = try JSONDecoder().decode(AgentEventEnvelope.self, from: line)
        } catch {
            send(.rejected(.invalidPayload), to: descriptor)
            finish(descriptor)
            return
        }

        let handler = self.handler
        Task { [weak self] in
            let receipt = await handler(event)
            guard let self else { return }
            send(receipt, to: descriptor)
            finish(descriptor)
        }
    }

    private func send(_ receipt: AgentEventReceipt, to descriptor: Int32) {
        guard var response = try? JSONEncoder().encode(receipt) else { return }
        response.append(0x0A)
        response.withUnsafeBytes { rawBuffer in
            guard var pointer = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let written = Darwin.send(descriptor, pointer, remaining, 0)
                guard written > 0 else { return }
                remaining -= written
                pointer = pointer.advanced(by: written)
            }
        }
    }

    private func finish(_ descriptor: Int32) {
        let owned = lock.withLock {
            connectionDescriptors.remove(descriptor) != nil
        }
        guard owned else { return }
        Darwin.shutdown(descriptor, SHUT_RDWR)
        Darwin.close(descriptor)
    }
}

enum AgentEventSocketClient {
    static func exchange(
        _ event: AgentEventEnvelope,
        at path: String
    ) throws -> AgentEventReceipt {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        defer { Darwin.close(descriptor) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else { throw AgentEventSocketError.pathTooLong }
        withUnsafeMutablePointer(to: &address.sun_path) { tuplePointer in
            let destination = UnsafeMutableRawPointer(tuplePointer)
                .assumingMemoryBound(to: CChar.self)
            path.withCString { source in
                _ = strncpy(destination, source, capacity - 1)
            }
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(
                    descriptor,
                    $0,
                    socklen_t(MemoryLayout<sockaddr_un>.size)
                )
            }
        }
        guard connected == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }

        var payload = try JSONEncoder().encode(event)
        payload.append(0x0A)
        try payload.withUnsafeBytes { bytes in
            guard var pointer = bytes.baseAddress else { return }
            var remaining = bytes.count
            while remaining > 0 {
                let written = Darwin.send(descriptor, pointer, remaining, 0)
                guard written > 0 else {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                }
                remaining -= written
                pointer = pointer.advanced(by: written)
            }
        }

        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 2_048)
        while response.count <= 8_192, !response.contains(0x0A) {
            let count = buffer.withUnsafeMutableBytes { bytes in
                recv(descriptor, bytes.baseAddress, bytes.count, 0)
            }
            guard count > 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            response.append(contentsOf: buffer.prefix(count))
        }
        guard response.count <= 8_192,
              let newline = response.firstIndex(of: 0x0A) else {
            throw AgentEventSocketError.invalidResponse
        }
        return try JSONDecoder().decode(AgentEventReceipt.self, from: response[..<newline])
    }
}
