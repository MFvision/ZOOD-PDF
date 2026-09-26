import Foundation
import ZoodCore
#if canImport(llama)
import llama
#endif

/// The portable model (Qwen3 GGUF) run by llama.cpp (MIT), on the device's GPU through Metal.
///
/// llama.cpp is linked from `Frameworks/llama.xcframework` (release b11200, fetched by
/// `scripts/ios/fetch-llama.sh`, SHA-256 pinned). That XCFramework has no simulator slice, so
/// it is linked for device builds only; in the simulator `canImport(llama)` is false and the
/// app offers Apple's model only. See ADR 0015.
final class PortableModelRunner: Sendable {
    static let shared = PortableModelRunner()

    static var isCompiledIn: Bool {
        #if canImport(llama)
        true
        #else
        false
        #endif
    }

    #if canImport(llama)
    private let engine = LlamaEngine()
    #endif

    /// Stream the visible answer for `prompt`. With `grammar` (GBNF) the output is constrained.
    func stream(_ prompt: LocalPrompt, modelPath: String, spec: LocalModelSpec, grammar: String? = nil)
        -> AsyncThrowingStream<String, any Error> {
        #if canImport(llama)
        let engine = engine
        return AsyncThrowingStream { continuation in
            let task = Task.detached(priority: .userInitiated) {
                do {
                    try await engine.load(path: modelPath, contextTokens: spec.contextTokens)
                    let text = ChatMLTemplate.render(system: prompt.instructions, user: prompt.prompt)
                    try await engine.generate(text: text, maxTokens: spec.budget.maxOutputTokens, grammar: grammar) { piece in
                        if !piece.isEmpty { continuation.yield(piece) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        #else
        return AsyncThrowingStream { $0.finish(throwing: LocalAIError.runtimeMissing) }
        #endif
    }

    /// Free the model's memory (memory warning, model deleted).
    func unload() async {
        #if canImport(llama)
        await engine.unload()
        #endif
    }
}

#if canImport(llama)
/// Owns the llama.cpp model and context; an actor so one generation runs at a time.
actor LlamaEngine {
    private var model: OpaquePointer?
    private var context: OpaquePointer?
    private var loadedPath: String?
    private var contextSize: Int32 = 0
    private static let backend: Void = llama_backend_init()

    func load(path: String, contextTokens: Int) throws {
        if loadedPath == path, context != nil { return }
        unload()
        _ = Self.backend
        let params = llama_model_default_params()
        guard let m = llama_model_load_from_file(path, params) else { throw LocalAIError.loadFailed }
        var cparams = llama_context_default_params()
        cparams.n_ctx = UInt32(contextTokens)
        cparams.n_batch = 512
        let threads = Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2)))
        cparams.n_threads = threads
        cparams.n_threads_batch = threads
        guard let c = llama_init_from_model(m, cparams) else {
            llama_model_free(m)
            throw LocalAIError.loadFailed
        }
        model = m
        context = c
        loadedPath = path
        contextSize = Int32(llama_n_ctx(c))
    }

    func unload() {
        if let context { llama_free(context) }
        if let model { llama_model_free(model) }
        context = nil
        model = nil
        loadedPath = nil
    }

    func generate(text: String, maxTokens: Int, grammar: String?, emit: @Sendable (String) -> Void) throws {
        guard let model, let context else { throw LocalAIError.loadFailed }
        let vocab = llama_model_get_vocab(model)
        llama_memory_clear(llama_get_memory(context), true)

        var tokens = tokenize(vocab, text)
        guard !tokens.isEmpty else { throw LocalAIError.generationFailed("tokenize") }
        guard tokens.count + maxTokens <= Int(contextSize) else { throw LocalAIError.contextOverflow }

        // Prompt, in batches.
        var start = 0
        while start < tokens.count {
            let n = min(512, tokens.count - start)
            let status = tokens.withUnsafeMutableBufferPointer { buf in
                llama_decode(context, llama_batch_get_one(buf.baseAddress! + start, Int32(n)))
            }
            guard status == 0 else { throw LocalAIError.generationFailed("decode \(status)") }
            start += n
        }

        // Qwen3 non-thinking settings (temperature 0.7, top-p 0.8, top-k 20); near-greedy
        // under a grammar (form autofill).
        let sampler = llama_sampler_chain_init(llama_sampler_chain_default_params())
        defer { llama_sampler_free(sampler) }
        if let grammar {
            guard let g = llama_sampler_init_grammar(vocab, grammar, "root") else {
                throw LocalAIError.generationFailed("grammar")
            }
            llama_sampler_chain_add(sampler, g)
        }
        llama_sampler_chain_add(sampler, llama_sampler_init_top_k(20))
        llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.8, 1))
        llama_sampler_chain_add(sampler, llama_sampler_init_temp(grammar == nil ? 0.7 : 0.1))
        llama_sampler_chain_add(sampler, llama_sampler_init_dist(UInt32.random(in: 0...UInt32.max)))

        var bytes = UTF8Assembler()
        var think = ThinkFilter()
        for _ in 0..<maxTokens {
            if Task.isCancelled { break }
            // Samples from the last logits and accepts the token into the sampler state.
            var token = llama_sampler_sample(sampler, context, -1)
            if llama_vocab_is_eog(vocab, token) { break }
            emit(think.feed(bytes.append(piece(vocab, token))))
            let status = withUnsafeMutablePointer(to: &token) { p in
                llama_decode(context, llama_batch_get_one(p, 1))
            }
            guard status == 0 else { break }
        }
        emit(think.feed(bytes.finish()))
        emit(think.finish())
    }

    private func tokenize(_ vocab: OpaquePointer?, _ text: String) -> [llama_token] {
        let count = Int32(text.utf8.count)
        var tokens = [llama_token](repeating: 0, count: Int(count) + 16)
        // add_special: BOS if the model wants one; parse_special: ChatML control tokens.
        var n = llama_tokenize(vocab, text, count, &tokens, Int32(tokens.count), true, true)
        if n < 0 {
            tokens = [llama_token](repeating: 0, count: Int(-n))
            n = llama_tokenize(vocab, text, count, &tokens, Int32(tokens.count), true, true)
        }
        return n > 0 ? Array(tokens.prefix(Int(n))) : []
    }

    private func piece(_ vocab: OpaquePointer?, _ token: llama_token) -> [UInt8] {
        var buf = [CChar](repeating: 0, count: 64)
        var n = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, false)
        if n < 0 {
            buf = [CChar](repeating: 0, count: Int(-n))
            n = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, false)
        }
        return buf.prefix(Int(max(n, 0))).map { UInt8(bitPattern: $0) }
    }
}
#endif
