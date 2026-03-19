#!/usr/bin/env bash
# llm_provider.sh — interactive LLM provider selection and API key validation
#
# Source this from install.sh or run.sh:
#   source scripts/setup/llm_provider.sh
#
# Requires: colors.sh sourced first
#
# Functions:
#   has_llm_provider ENV_FILE  — returns 0 if any LLM provider key is set
#   setup_llm_provider         — interactive multi-provider selection + validation
#                                Sets: LLM_PROVIDERS (array of KEY=VALUE pairs)
#   write_llm_to_env ENV_FILE  — appends LLM config to the given .env file

has_llm_provider() {
    local env_file="$1"
    [ -f "$env_file" ] || return 1
    local key val
    for key in GEMINI_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY; do
        val=$(sed -n "s/^${key}=\(.*\)$/\1/p" "$env_file" 2>/dev/null || true)
        if [ -n "$val" ]; then
            return 0
        fi
    done
    val=$(sed -n 's/^OLLAMA_BASE_URL=\(.*\)$/\1/p' "$env_file" 2>/dev/null || true)
    [ -n "$val" ]
}

# Array to collect all provider key=value pairs
LLM_PROVIDERS=()

_validate_key() {
    local key_name="$1" key_value="$2"
    if [ -z "${key_name}" ] || [ -z "${key_value}" ]; then
        return 0
    fi
    if ! type run_crypto &>/dev/null; then
        return 0
    fi
    while true; do
        printf "  Validating API key... "
        if run_crypto scripts/validate_key.py "${key_name}" "${key_value}" >/dev/null 2>&1; then
            echo -e "${GREEN}✓${RESET}"
            return 0
        else
            echo -e "${YELLOW}✗${RESET} key did not work"
            echo ""
            echo -e "    ${CYAN}1)${RESET} Re-enter key"
            echo -e "    ${CYAN}2)${RESET} Continue anyway"
            echo ""
            printf "  Choice [1-2]: "
            local retry_choice
            read -r retry_choice
            case "${retry_choice}" in
                1)
                    printf "  Enter your API key: "
                    read -r key_value
                    if [ -z "${key_value}" ]; then
                        return 1
                    fi
                    ;;
                *)
                    return 0
                    ;;
            esac
        fi
    done
}

_ask_provider_key() {
    local provider_name="$1" key_env="$2"
    echo ""
    printf "  ${BOLD}${provider_name}${RESET} API key: "
    local key_value
    read -r key_value
    if [ -z "${key_value}" ]; then
        echo -e "  ${DIM}Skipped${RESET}"
        return
    fi
    if _validate_key "${key_env}" "${key_value}"; then
        LLM_PROVIDERS+=("${key_env}=${key_value}")
    fi
}

setup_llm_provider() {
    LLM_PROVIDERS=()

    if [ ! -t 0 ]; then
        info "Non-interactive mode — skipping provider selection"
        return
    fi

    local has_gemini=false has_openai=false has_claude=false has_openrouter=false has_ollama=false
    local provider_choices _valid

    while true; do
        echo ""
        echo -e "  ${BOLD}Which LLM providers would you like to configure?${RESET}"
        echo -e "  ${DIM}You can select multiple providers. Dina will use them for different tasks.${RESET}"
        echo ""
        echo -e "    ${CYAN}1)${RESET} Google Gemini"
        echo -e "    ${CYAN}2)${RESET} OpenAI GPT"
        echo -e "    ${CYAN}3)${RESET} Anthropic Claude"
        echo -e "    ${CYAN}4)${RESET} OpenRouter"
        echo -e "    ${CYAN}5)${RESET} Ollama"
        echo -e "    ${CYAN}6)${RESET} Skip"
        echo ""
        echo -e "  ${DIM}Enter one or more numbers separated by spaces (e.g. 1 3):${RESET}"
        printf "  > "
        read -r provider_choices

        # Validate: every token must be 1-6
        _valid=true
        if [ -z "${provider_choices}" ]; then
            _valid=false
        fi
        for choice in ${provider_choices}; do
            case "${choice}" in
                1|2|3|4|5|6) ;;
                *) _valid=false ;;
            esac
        done

        if [ "${_valid}" = true ]; then
            break
        fi
        echo ""
        echo -e "  ${YELLOW}Please enter numbers 1-6 only.${RESET}"
    done

    # Parse choices
    for choice in ${provider_choices}; do
        case "${choice}" in
            1) has_gemini=true ;;
            2) has_openai=true ;;
            3) has_claude=true ;;
            4) has_openrouter=true ;;
            5) has_ollama=true ;;
            6) return ;;
        esac
    done

    # Collect API keys for each selected provider
    if [ "${has_gemini}" = true ]; then
        _ask_provider_key "Google Gemini" "GEMINI_API_KEY"
    fi

    if [ "${has_openai}" = true ]; then
        _ask_provider_key "OpenAI GPT" "OPENAI_API_KEY"
    fi

    if [ "${has_claude}" = true ]; then
        _ask_provider_key "Anthropic Claude" "ANTHROPIC_API_KEY"
    fi

    if [ "${has_openrouter}" = true ]; then
        _ask_provider_key "OpenRouter" "OPENROUTER_API_KEY"
        # Add default model for OpenRouter
        for entry in "${LLM_PROVIDERS[@]}"; do
            if [[ "${entry}" == OPENROUTER_API_KEY=* ]]; then
                LLM_PROVIDERS+=("OPENROUTER_MODEL=google/gemini-3-flash")
                break
            fi
        done
    fi

    if [ "${has_ollama}" = true ]; then
        echo ""
        echo -e "  ${DIM}Using local Ollama at http://localhost:11434${RESET}"
        echo -e "  ${DIM}Make sure Ollama is running: ollama serve${RESET}"
        LLM_PROVIDERS+=("OLLAMA_BASE_URL=http://localhost:11434")
    fi

    # Summary
    local count=0
    for _ in "${LLM_PROVIDERS[@]}"; do
        # Don't count OPENROUTER_MODEL as a separate provider
        count=$((count + 1))
    done
    if [ ${count} -gt 0 ]; then
        echo ""
        echo -e "  ${GREEN}${count} provider(s) configured${RESET}"
    fi
}

write_llm_to_env() {
    local env_file="$1"
    if [ ${#LLM_PROVIDERS[@]} -eq 0 ]; then
        return
    fi
    echo "" >> "${env_file}"
    echo "# LLM Providers" >> "${env_file}"
    for entry in "${LLM_PROVIDERS[@]}"; do
        echo "${entry}" >> "${env_file}"
    done
}
