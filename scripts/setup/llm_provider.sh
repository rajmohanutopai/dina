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
#   setup_llm_provider         — interactive provider selection + validation
#                                Sets: LLM_KEY_NAME, LLM_KEY_VALUE, LLM_EXTRA_LINES
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

setup_llm_provider() {
    LLM_KEY_NAME=""
    LLM_KEY_VALUE=""
    LLM_EXTRA_LINES=""

    echo ""
    echo -e "  ${BOLD}Which LLM provider would you like to use?${RESET}"
    echo ""
    echo -e "    ${CYAN}1)${RESET} Google Gemini"
    echo -e "    ${CYAN}2)${RESET} OpenAI GPT"
    echo -e "    ${CYAN}3)${RESET} Anthropic Claude"
    echo -e "    ${CYAN}4)${RESET} OpenRouter"
    echo -e "    ${CYAN}5)${RESET} Ollama"
    echo -e "    ${CYAN}6)${RESET} Skip"
    echo ""

    local provider_choice=""

    if [ -t 0 ]; then
        printf "  Enter choice [1-6]: "
        read -r provider_choice
    else
        provider_choice="6"
        info "Non-interactive mode — skipping provider selection"
    fi

    case "${provider_choice}" in
        1)
            LLM_KEY_NAME="GEMINI_API_KEY"
            echo ""
            printf "  Enter your Gemini API key: "
            read -r LLM_KEY_VALUE
            ;;
        2)
            LLM_KEY_NAME="OPENAI_API_KEY"
            echo ""
            printf "  Enter your OpenAI API key: "
            read -r LLM_KEY_VALUE
            ;;
        3)
            LLM_KEY_NAME="ANTHROPIC_API_KEY"
            echo ""
            printf "  Enter your Anthropic API key: "
            read -r LLM_KEY_VALUE
            ;;
        4)
            LLM_KEY_NAME="OPENROUTER_API_KEY"
            LLM_EXTRA_LINES="OPENROUTER_MODEL=google/gemini-3-flash"  # must match models.json
            echo ""
            printf "  Enter your OpenRouter API key: "
            read -r LLM_KEY_VALUE
            ;;
        5)
            LLM_KEY_NAME="OLLAMA_BASE_URL"
            LLM_KEY_VALUE="http://localhost:11434"
            echo ""
            echo -e "  ${DIM}Using local Ollama at http://localhost:11434${RESET}"
            echo -e "  ${DIM}Make sure Ollama is running: ollama serve${RESET}"
            ;;
        *)
            info "Skipping provider setup — edit .env later to add your API key"
            ;;
    esac

    # Validate API key immediately using the crypto Docker container.
    # validate_key.py uses only stdlib (urllib) — no pip packages needed.
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ] && [ -t 0 ] && type run_crypto &>/dev/null; then
        while true; do
            printf "  Validating API key... "
            if run_crypto scripts/validate_key.py "${LLM_KEY_NAME}" "${LLM_KEY_VALUE}" >/dev/null 2>&1; then
                echo -e "${GREEN}✓${RESET}"
                break
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
                        read -r LLM_KEY_VALUE
                        if [ -z "${LLM_KEY_VALUE}" ]; then
                            info "Empty key — skipping"
                            LLM_KEY_NAME=""
                            LLM_KEY_VALUE=""
                            break
                        fi
                        ;;
                    *)
                        break
                        ;;
                esac
            fi
        done
    fi
}

write_llm_to_env() {
    local env_file="$1"
    if [ -n "${LLM_KEY_NAME}" ] && [ -n "${LLM_KEY_VALUE}" ]; then
        echo "" >> "${env_file}"
        echo "# LLM Provider" >> "${env_file}"
        echo "${LLM_KEY_NAME}=${LLM_KEY_VALUE}" >> "${env_file}"
        if [ -n "${LLM_EXTRA_LINES}" ]; then
            echo "${LLM_EXTRA_LINES}" >> "${env_file}"
        fi
    fi
}
